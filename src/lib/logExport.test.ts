import { describe, expect, it } from "vitest";
import { EMPTY_FILTER } from "./logFilter";
import {
  exportBody,
  exportName,
  logHeader,
  type ExportContext,
} from "./logExport";

// Fixed so the assertions are about the format, not about when the test
// happened to run.
const AT = new Date("2026-08-16T09:05:03.000Z");

function ctx(over: Partial<ExportContext> = {}): ExportContext {
  return {
    namespace: "kube-system",
    pod: "coredns-abc",
    container: "coredns",
    filter: EMPTY_FILTER,
    context: 0,
    timestamps: true,
    dropped: 0,
    retained: 3,
    written: 3,
    at: AT,
    ...over,
  };
}

describe("exportName", () => {
  it("names the file for the pod, container and time", () => {
    const name = exportName(ctx());
    expect(name).toMatch(/^coredns-abc-coredns-\d{8}-\d{6}\.log$/);
  });

  it("sorts chronologically", () => {
    // Date-first ordering, so a directory of saved logs reads in order.
    const early = exportName(ctx({ at: new Date("2026-08-16T09:00:00Z") }));
    const late = exportName(ctx({ at: new Date("2026-08-16T11:00:00Z") }));
    expect([late, early].sort()).toEqual([early, late]);
  });

  it("does not put cluster-supplied text straight into a path", () => {
    // The container name comes from the cluster. It should not be able
    // to introduce a separator, however unlikely that is in practice.
    const name = exportName(ctx({ container: "../../etc/passwd" }));
    expect(name).not.toContain("/");
    expect(name).not.toContain("..");
  });
});

describe("logHeader", () => {
  it("records which pod and container the lines came from", () => {
    const header = logHeader(ctx());
    expect(header).toContain("kube-system/coredns-abc");
    expect(header).toContain("coredns");
    expect(header).toContain(AT.toISOString());
  });

  it("says nothing about filtering when nothing was filtered", () => {
    expect(logHeader(ctx())).not.toContain("filter:");
  });

  it("discloses the filter the output was taken through", () => {
    // The most misleading artefact this app could produce is a filtered
    // log that does not say it is filtered.
    const header = logHeader(
      ctx({
        filter: { ...EMPTY_FILTER, include: "error" },
        retained: 100,
        written: 4,
      }),
    );
    expect(header).toContain("filter:");
    expect(header).toContain("/error/");
    expect(header).toContain("4 of 100");
  });

  it("distinguishes a regex filter from a text one", () => {
    const asText = logHeader(ctx({ filter: { ...EMPTY_FILTER, include: "a.b" } }));
    const asRegex = logHeader(
      ctx({ filter: { ...EMPTY_FILTER, include: "a.b", regex: true } }),
    );
    expect(asText).toContain("text /a.b/");
    expect(asRegex).toContain("regex /a.b/");
  });

  it("records an exclusion", () => {
    const header = logHeader(
      ctx({ filter: { ...EMPTY_FILTER, exclude: "healthz" } }),
    );
    expect(header).toContain("excluding");
    expect(header).toContain("/healthz/");
  });

  it("records context lines, which change what the file contains", () => {
    const header = logHeader(
      ctx({ filter: { ...EMPTY_FILTER, include: "boom" }, context: 3 }),
    );
    expect(header).toContain("3 lines of context");
  });

  it("warns when the buffer cap already lost earlier lines", () => {
    // Otherwise the file reads as the pod's whole output, and whoever
    // opens it later concludes the incident started at the first line.
    const header = logHeader(ctx({ dropped: 12_000 }));
    expect(header).toMatch(/12000 earlier line/);
  });

  it("warns when the lines carry no timestamps", () => {
    const header = logHeader(ctx({ timestamps: false }));
    expect(header).toContain("without timestamps");
  });

  it("says nothing about timestamps when they are present", () => {
    expect(logHeader(ctx({ timestamps: true }))).not.toContain("without timestamps");
  });

  it("comments every line so the file still reads as a log", () => {
    const header = logHeader(ctx({ dropped: 5, timestamps: false }));
    for (const line of header.split("\n")) {
      expect(line.startsWith("#")).toBe(true);
    }
  });
});

describe("exportBody", () => {
  it("puts the header above the lines, separated by a blank line", () => {
    const body = exportBody(ctx(), ["one", "two", "three"]);
    const [first] = body.split("\n\n");
    expect(first).toBe(logHeader(ctx()));
    expect(body).toContain("one\ntwo\nthree");
  });

  it("ends with a newline", () => {
    // Concatenating or tailing a file without one is a nuisance.
    expect(exportBody(ctx(), ["only"])).toMatch(/\n$/);
  });

  it("writes an empty log as a header and nothing else", () => {
    const body = exportBody(ctx({ retained: 0, written: 0 }), []);
    expect(body.trimEnd()).toBe(logHeader(ctx({ retained: 0, written: 0 })));
  });
});
