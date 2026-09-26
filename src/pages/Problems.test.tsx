import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Message, Problems } from "./Problems";
import type { ProblemsSnapshot } from "../lib/api";
import type { ListView } from "../lib/routes";
import type { ProblemsState } from "../lib/useProblems";
import { demoProblems } from "../dev/fixtures";

// The view renders what the core decided. What is worth covering here is
// that it says so legibly: rows worst-first with their reasons, a category
// Loupe could not check stated rather than implied empty, the namespace
// filter and sort kept on the route, and a click reporting the right row.

const NOW = 1_800_000_000;

function state(snapshot: ProblemsSnapshot | null, error: string | null = null): ProblemsState {
  return { snapshot, receivedAt: snapshot ? Date.now() : 0, error };
}

function setup(s: ProblemsState, view: ListView = {}) {
  const onOpen = vi.fn();
  const onView = vi.fn();
  const utils = render(<Problems state={s} onOpen={onOpen} view={view} onView={onView} />);
  return { onOpen, onView, user: userEvent.setup(), ...utils };
}

const demo = () => demoProblems(NOW) as unknown as ProblemsSnapshot;

describe("Problems", () => {
  it("lists every row with its reason and a readable age", () => {
    setup(state(demo()));
    expect(screen.getByText("checkout-7f9c-x2k")).toBeInTheDocument();
    expect(screen.getByText("CrashLoopBackOff")).toBeInTheDocument();
    expect(screen.getByText("41m")).toBeInTheDocument();
    expect(screen.getByText("9 items")).toBeInTheDocument();
  });

  it("shows a deduplicated event once, with how many times it fired", () => {
    setup(state(demo()));
    expect(screen.getByText("×40")).toBeInTheDocument();
  });

  it("says a category could not be checked rather than implying it is fine", () => {
    setup(state(demo()));
    expect(screen.getByText(/Not permitted to list cronjobs/)).toBeInTheDocument();
  });

  it("opens the row that was clicked, with the intent it was clicked with", async () => {
    const { onOpen, user } = setup(state(demo()));
    await user.click(screen.getByText("web-5d8b-q7p"));
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "ImagePullBackOff" }),
      "here",
    );
  });

  it("does nothing for a row with nothing behind it", async () => {
    const { onOpen, user } = setup(state(demo()));
    await user.click(screen.getByText(/Not permitted to list cronjobs/));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("filters by the namespace on the route, keeping cluster-wide rows", () => {
    setup(state(demo()), { namespace: "ml" });
    expect(screen.getByText("3 items")).toBeInTheDocument();
    expect(screen.queryByText("checkout-7f9c-x2k")).not.toBeInTheDocument();
    expect(screen.getByText(/Not permitted to list cronjobs/)).toBeInTheDocument();
  });

  it("reports a namespace change to the route rather than holding it", async () => {
    const { onView, user } = setup(state(demo()));
    await user.selectOptions(screen.getByTitle("Namespace"), "shop");
    expect(onView).toHaveBeenCalledWith({ namespace: "shop" });
  });

  it("sorts by age in seconds when asked, oldest last on ascending", () => {
    setup(state(demo()), { sort: { key: "age", direction: "asc" } });
    const rows = screen.getAllByRole("row").slice(1);
    // Ascending age: the 45s event first, the 5h CronJob last among dated
    // rows, and the undated stand-in wherever nulls sort.
    expect(within(rows[0]).getByText("FailedScheduling")).toBeInTheDocument();
    expect(rows.some((r) => within(r).queryByText("5h"))).toBe(true);
  });

  it("says it is still looking until every source has answered", () => {
    const loading = { ...demo(), problems: [], sources: [{ source: "pods", category: "pods", state: "loading" }] };
    setup(state(loading as unknown as ProblemsSnapshot));
    expect(screen.getByText("Still checking the cluster…")).toBeInTheDocument();
  });

  it("says nothing is broken only once it has checked", () => {
    const clear = { ...demo(), problems: [], sources: [{ source: "pods", category: "pods", state: "ready" }] };
    setup(state(clear as unknown as ProblemsSnapshot));
    expect(screen.getByText("Nothing is broken.")).toBeInTheDocument();
  });

  it("shows the error when the monitor could not start", () => {
    setup(state(null, "not connected to a cluster"));
    expect(screen.getByText(/not connected to a cluster/)).toBeInTheDocument();
  });
});

describe("Message", () => {
  it("sets quoted names as code", () => {
    const { container } = render(<Message text="Container `app` is crash-looping" />);
    expect(container.querySelector("code")?.textContent).toBe("app");
  });

  it("leaves an unpaired backtick as written", () => {
    const { container } = render(<Message text="odd ` tick" />);
    expect(container.querySelector("code")).toBeNull();
    expect(container.textContent).toBe("odd ` tick");
  });
});
