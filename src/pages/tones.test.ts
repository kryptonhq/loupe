import { describe, expect, it } from "vitest";
import { statusTone } from "./ObjectDetail";
import { releaseTone } from "./Helm";

// Colour is a claim about health. These two functions make that claim
// for vocabularies we do not control (a CRD's) and one we do (Helm's),
// and the interesting cases are the ones where guessing would be wrong.

describe("statusTone", () => {
  it("reads the words CRDs commonly use for healthy", () => {
    for (const status of ["Ready", "Running", "Active", "Available", "Healthy", "Bound"]) {
      expect(statusTone(status), status).toBe("ok");
    }
  });

  it("reads the words for in-flight as a warning, not as healthy", () => {
    for (const status of ["Pending", "Creating", "Updating", "InProgress", "Unknown"]) {
      expect(statusTone(status), status).toBe("warn");
    }
  });

  it("reads failure words as failure", () => {
    for (const status of ["Failed", "Error", "CrashLoopBackOff", "Degraded", "Unhealthy"]) {
      expect(statusTone(status), status).toBe("danger");
    }
  });

  it("does not colour NotReady green for containing Ready", () => {
    // The substring trap: "NotReady" and "NotReady: ModelPullFailed"
    // both contain "Ready", and painting either green would be the most
    // misleading thing this function could do.
    expect(statusTone("NotReady")).toBe("warn");
    expect(statusTone("NotReady: ModelPullFailed")).toBe("danger");
  });

  it("stays neutral on a word it does not recognise", () => {
    // CRDs invent their own vocabulary. Guessing at one we have never
    // seen is a claim about health we cannot support.
    expect(statusTone("Quiesced")).toBe("unknown");
    expect(statusTone("")).toBe("unknown");
  });

  it("finds the verdict inside a camelCase reason", () => {
    // These arrive as one word. Matching on word boundaries alone would
    // miss the "Failed" and paint a broken object amber.
    expect(statusTone("CrashLoopBackOff")).toBe("danger");
    expect(statusTone("ImagePullBackOff")).toBe("danger");
    expect(statusTone("CreateContainerError")).toBe("danger");
    expect(statusTone("ContainerCreating")).toBe("warn");
  });

  it("ignores case, since CRDs disagree about it", () => {
    expect(statusTone("ready")).toBe("ok");
    expect(statusTone("FAILED")).toBe("danger");
  });
});

describe("releaseTone", () => {
  it("greens only a deployed release", () => {
    expect(releaseTone("deployed")).toBe("ok");
    expect(releaseTone("failed")).toBe("danger");
  });

  it("warns while an operation is still in flight", () => {
    expect(releaseTone("pending-install")).toBe("warn");
    expect(releaseTone("pending-upgrade")).toBe("warn");
    expect(releaseTone("uninstalling")).toBe("warn");
  });

  it("treats a superseded revision as neither good nor bad", () => {
    // Every revision but the current one is superseded; painting them
    // red would make a healthy release's history look like a disaster.
    expect(releaseTone("superseded")).toBe("unknown");
    expect(releaseTone("uninstalled")).toBe("unknown");
  });
});
