import { describe, expect, it } from "vitest";
import { containerPorts, workloadSelector } from "./kinds";

// The selector a merged log view streams by. Read out of the YAML the
// detail payload already carries, so nothing else needs a parser.
// Getting it wrong means streaming the wrong pods, which is worse than
// streaming none — hence the deliberate refusals below.

const DEPLOYMENT = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api
      tier: backend
  template:
    metadata:
      labels:
        app: api
`;

describe("workloadSelector", () => {
  it("reads matchLabels as the API server's selector syntax", () => {
    expect(workloadSelector("Deployment", DEPLOYMENT)).toBe("app=api,tier=backend");
  });

  it("reads a single label", () => {
    const yaml = `spec:
  selector:
    matchLabels:
      app: api
`;
    expect(workloadSelector("StatefulSet", yaml)).toBe("app=api");
  });

  it("strips quotes the server may have added", () => {
    const yaml = `spec:
  selector:
    matchLabels:
      app: "api"
`;
    expect(workloadSelector("Deployment", yaml)).toBe("app=api");
  });

  it("stops at the end of the label block", () => {
    // Reading into `template:` would produce a selector of half the
    // manifest and match nothing.
    expect(workloadSelector("Deployment", DEPLOYMENT)).not.toContain("template");
  });

  it("offers nothing for a kind whose pods it does not stream", () => {
    // A Service has a selector too, but a Logs tab there would promise
    // something this does not do: it streams pods, not traffic.
    const yaml = `spec:
  selector:
    app: api
`;
    expect(workloadSelector("Service", yaml)).toBeNull();
    expect(workloadSelector("ConfigMap", DEPLOYMENT)).toBeNull();
  });

  it("refuses a matchExpressions selector rather than approximating it", () => {
    // A selector that is nearly right streams the wrong pods. Streaming
    // none is a much better failure.
    const yaml = `spec:
  selector:
    matchExpressions:
      - key: app
        operator: In
        values: [api]
`;
    expect(workloadSelector("Deployment", yaml)).toBeNull();
  });

  it("returns null when there is no selector at all", () => {
    expect(workloadSelector("Deployment", "spec:\n  replicas: 1\n")).toBeNull();
  });

  it("returns null for an empty matchLabels block", () => {
    const yaml = `spec:
  selector:
    matchLabels:
  template: {}
`;
    expect(workloadSelector("Deployment", yaml)).toBeNull();
  });

  it("does not mistake a nested selector for the workload's own", () => {
    // Only the one at spec.selector counts; anything deeper belongs to
    // something else in the manifest.
    const yaml = `spec:
  template:
    spec:
      selector:
        matchLabels:
          app: wrong
`;
    expect(workloadSelector("Deployment", yaml)).toBeNull();
  });
});

describe("containerPorts", () => {
  it("finds the ports a manifest declares", () => {
    const yaml = `spec:
  containers:
    - name: api
      ports:
        - containerPort: 8080
        - containerPort: 9090
`;
    expect(containerPorts(yaml)).toEqual([8080, 9090]);
  });

  it("keeps declaration order, because the first is usually the one wanted", () => {
    const yaml = "ports:\n  - containerPort: 9090\n  - containerPort: 8080\n";
    expect(containerPorts(yaml)).toEqual([9090, 8080]);
  });

  it("lists a port once however many times it appears", () => {
    const yaml = `spec:
  ports:
    - port: 80
      targetPort: 80
`;
    expect(containerPorts(yaml)).toEqual([80]);
  });

  it("ignores anything outside the port range", () => {
    // A resource limit or a UID is not a port.
    const yaml = "port: 0\nport: 70000\ncontainerPort: 443\n";
    expect(containerPorts(yaml)).toEqual([443]);
  });

  it("ignores a named targetPort", () => {
    // `targetPort: http` is a name, not a number, and forwarding to it
    // would need resolving against the pod.
    expect(containerPorts("targetPort: http\n")).toEqual([]);
  });

  it("returns nothing for a manifest with no ports", () => {
    expect(containerPorts("metadata:\n  name: x\n")).toEqual([]);
  });
});
