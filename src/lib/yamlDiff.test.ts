import { describe, expect, it } from "vitest";
import { diffYaml, stripServerFields } from "./yamlDiff";

const MANIFEST = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: payments
  resourceVersion: "48211"
  uid: 3f2b1c00-1111-2222-3333-444455556666
  creationTimestamp: "2026-01-04T09:11:02Z"
  generation: 7
  managedFields:
  - manager: kubectl
    operation: Update
    fieldsV1:
      f:spec:
        f:replicas: {}
  labels:
    app: api
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: api
        image: registry.example.com/api:1.4.2
status:
  readyReplicas: 3
  conditions:
  - type: Available
    status: "True"
`;

function lines(yaml: string) {
  return stripServerFields(yaml).join("\n");
}

describe("stripServerFields", () => {
  it("drops the fields the server owns", () => {
    const stripped = lines(MANIFEST);
    expect(stripped).not.toContain("resourceVersion");
    expect(stripped).not.toContain("uid:");
    expect(stripped).not.toContain("creationTimestamp");
    expect(stripped).not.toContain("generation:");
  });

  it("drops managedFields and everything nested under it", () => {
    // The block is long and entirely noise; leaving its children behind
    // would be worse than leaving the block.
    const stripped = lines(MANIFEST);
    expect(stripped).not.toContain("managedFields");
    expect(stripped).not.toContain("manager: kubectl");
    expect(stripped).not.toContain("f:replicas");
  });

  it("drops the whole status block", () => {
    const stripped = lines(MANIFEST);
    expect(stripped).not.toContain("status:");
    expect(stripped).not.toContain("readyReplicas");
    expect(stripped).not.toContain("type: Available");
  });

  it("keeps everything the user owns", () => {
    const stripped = lines(MANIFEST);
    expect(stripped).toContain("name: api");
    expect(stripped).toContain("replicas: 3");
    expect(stripped).toContain("image: registry.example.com/api:1.4.2");
    expect(stripped).toContain("app: api");
  });

  it("keeps a nested field that merely shares a server field's name", () => {
    // `uid` in an annotation or a container env var is the user's data.
    // Only direct children of metadata are the server's.
    const yaml = `metadata:
  name: x
  annotations:
    uid: keep-me
`;
    expect(lines(yaml)).toContain("uid: keep-me");
  });

  it("does not strip a status field nested inside spec", () => {
    const yaml = `spec:
  status: enabled
`;
    expect(lines(yaml)).toContain("status: enabled");
  });
});

describe("diffYaml", () => {
  it("reports no change when only server fields differ", () => {
    // The common case for a refetch: same object, new resourceVersion.
    // Offering that as a diff would train people to click through it.
    const before = MANIFEST;
    const after = MANIFEST.replace('"48211"', '"48999"').replace(
      "readyReplicas: 3",
      "readyReplicas: 2",
    );
    expect(diffYaml(before, after).empty).toBe(true);
  });

  it("reports nothing for an identical document", () => {
    expect(diffYaml(MANIFEST, MANIFEST).empty).toBe(true);
  });

  it("shows a one-field edit as one change", () => {
    const after = MANIFEST.replace("replicas: 3", "replicas: 5");
    const diff = diffYaml(before(), after);

    expect(diff.empty).toBe(false);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.hunks).toHaveLength(1);

    const changed = diff.hunks[0].lines.filter((l) => l.kind !== "context");
    expect(changed.map((l) => l.text.trim())).toEqual([
      "replicas: 3",
      "replicas: 5",
    ]);
  });

  it("shows only the hunks, not the whole manifest", () => {
    // The point of a diff on a 400-line object.
    const long = `${MANIFEST}${Array.from({ length: 200 }, (_, i) => `# filler ${i}`).join("\n")}\n`;
    const after = long.replace("replicas: 3", "replicas: 4");
    const diff = diffYaml(long, after);

    const total = diff.hunks.reduce((n, h) => n + h.lines.length, 0);
    expect(total).toBeLessThan(20);
  });

  it("marks a change to a field that carries weight", () => {
    // A one-character image tag change and a re-indent are the same size
    // in a diff and not remotely the same size in consequence.
    const after = MANIFEST.replace("api:1.4.2", "api:1.4.3");
    const diff = diffYaml(before(), after);

    const changed = diff.hunks.flatMap((h) => h.lines).filter((l) => l.kind !== "context");
    expect(changed.every((l) => l.weighty)).toBe(true);
  });

  it("does not mark an ordinary field as weighty", () => {
    const yaml = "metadata:\n  labels:\n    team: payments\n";
    const after = yaml.replace("payments", "billing");
    const diff = diffYaml(yaml, after);

    const changed = diff.hunks.flatMap((h) => h.lines).filter((l) => l.kind !== "context");
    expect(changed.some((l) => l.weighty)).toBe(false);
  });

  it("reports an added line as added and nothing as removed", () => {
    const after = MANIFEST.replace(
      "    app: api",
      "    app: api\n    tier: backend",
    );
    const diff = diffYaml(before(), after);

    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(0);
  });

  it("reports a deletion", () => {
    const after = MANIFEST.replace("    app: api\n", "");
    const diff = diffYaml(before(), after);

    expect(diff.removed).toBe(1);
    expect(diff.added).toBe(0);
  });

  it("separates distant changes into separate hunks", () => {
    const after = MANIFEST.replace("name: api", "name: api-v2").replace(
      "api:1.4.2",
      "api:2.0.0",
    );
    expect(diffYaml(before(), after).hunks.length).toBeGreaterThan(1);
  });

  it("numbers lines against the document the user is looking at", () => {
    const after = MANIFEST.replace("replicas: 3", "replicas: 5");
    const diff = diffYaml(before(), after);
    const [hunk] = diff.hunks;

    // Line numbers are only useful if they point at the stripped
    // document the diff is showing, consistently.
    expect(hunk.from).toBeGreaterThan(0);
    for (const line of hunk.lines) expect(line.line).toBeGreaterThan(0);
  });

  it("handles a document that was replaced wholesale", () => {
    const diff = diffYaml("a: 1\nb: 2\n", "x: 9\ny: 8\n");
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(2);
  });

  it("handles an empty original", () => {
    const diff = diffYaml("", "a: 1\n");
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(0);
  });

  it("treats a trailing newline as no change", () => {
    // Editors add and remove them; it is never what the user meant.
    expect(diffYaml("a: 1", "a: 1\n").empty).toBe(true);
  });
});

/// The unmodified manifest, named so the tests above read as before/after.
function before() {
  return MANIFEST;
}
