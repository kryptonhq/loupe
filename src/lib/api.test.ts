// Vite inlines these at build time, so the drift check below needs no
// filesystem access and no Node type definitions.
import libRs from "../../src-tauri/src/lib.rs?raw";
import apiTs from "./api.ts?raw";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { api, errorMessage, isApiError, isConflict } from "./api";

// Two things are covered here.
//
// The first is the command names. They are strings on this side and
// function names on the Rust side, and nothing in either compiler
// connects them — a rename in lib.rs leaves this file calling a command
// that no longer exists, and the failure shows up at runtime as an
// unhandled rejection with no obvious cause. The last test in this file
// reads lib.rs and compares the two sets directly.
//
// The second is argument naming. Tauri matches arguments by name, so
// `{ namespace }` and `{ ns }` are not interchangeable, and getting one
// wrong produces a command that runs with a null it did not expect.

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {},
}));

const invoked = vi.mocked(invoke);

beforeEach(() => {
  invoked.mockReset();
  invoked.mockResolvedValue(undefined);
});

/// The command name and payload of the last invoke.
function lastCall() {
  const calls = invoked.mock.calls;
  const [command, args] = calls[calls.length - 1];
  return { command, args };
}

describe("api command names and arguments", () => {
  it("sends an absent namespace as null rather than omitting it", async () => {
    // "All namespaces" and "the namespace named undefined" are different
    // requests. Tauri would deserialise a missing key as an error on a
    // non-Option parameter, and the cluster-wide listing is the default
    // view — so this is the path most likely to be exercised.
    await api.listPods();
    expect(lastCall()).toEqual({
      command: "list_pods",
      args: { namespace: null },
    });

    await api.listPods("kube-system");
    expect(lastCall().args).toEqual({ namespace: "kube-system" });
  });

  it("names every argument the way the Rust side declares it", async () => {
    const resource = { group: "apps", version: "v1", kind: "Deployment" };

    await api.connect("orbstack");
    expect(lastCall()).toEqual({ command: "connect", args: { context: "orbstack" } });

    await api.getPod("prod", "web");
    expect(lastCall()).toEqual({
      command: "get_pod",
      args: { namespace: "prod", name: "web" },
    });

    await api.getNode("worker-1");
    expect(lastCall()).toEqual({ command: "get_node", args: { name: "worker-1" } });

    await api.listPodsOnNode("worker-1");
    expect(lastCall()).toEqual({
      command: "list_pods_on_node",
      args: { node: "worker-1" },
    });

    await api.listEvents("prod", "web");
    expect(lastCall()).toEqual({
      command: "list_events",
      args: { namespace: "prod", name: "web" },
    });

    await api.getObject(resource, "prod", "web");
    expect(lastCall()).toEqual({
      command: "get_object",
      args: { resource, namespace: "prod", name: "web" },
    });

    await api.listTable(resource);
    expect(lastCall()).toEqual({
      command: "list_table",
      args: { resource, namespace: null },
    });

    await api.getHelmRelease("monitoring", "prom");
    expect(lastCall()).toEqual({
      command: "get_helm_release",
      args: { namespace: "monitoring", name: "prom" },
    });

    await api.stopPodLogs(7);
    expect(lastCall()).toEqual({ command: "stop_pod_logs", args: { id: 7 } });

    await api.setTheme("dark");
    expect(lastCall()).toEqual({ command: "set_theme", args: { theme: "dark" } });
  });

  it("asks for no Secret values by default", async () => {
    // The default has to be the safe one. A caller that forgets the
    // third argument must not get every credential in the object.
    await api.getSecretData("prod", "db-credentials");
    expect(lastCall()).toEqual({
      command: "get_secret_data",
      args: { namespace: "prod", name: "db-credentials", reveal: [] },
    });
  });

  it("sends the edit target alongside the text", async () => {
    // The target is what makes a rename detectable: without it the Rust
    // side would have to trust whatever identity the edited text claims.
    const target = {
      apiVersion: "v1",
      kind: "ConfigMap",
      namespace: "prod",
      name: "settings",
    };
    await api.applyYaml(target, "kind: ConfigMap\n");
    expect(lastCall()).toEqual({
      command: "apply_yaml",
      args: { target, yaml: "kind: ConfigMap\n" },
    });
  });
});

describe("error handling across the IPC boundary", () => {
  it("recognises a conflict by its kind, not its wording", () => {
    // The message is written for a human and will be reworded. The kind
    // is the contract, and it is what gates the editor's reload path.
    expect(isConflict({ kind: "conflict", message: "anything at all" })).toBe(true);
    expect(isConflict({ kind: "kubernetes", message: "409 Conflict" })).toBe(
      false,
    );
    expect(isConflict("conflict")).toBe(false);
    expect(isConflict(null)).toBe(false);
    expect(isConflict(undefined)).toBe(false);
  });

  it("gets a message out of anything that can be thrown", () => {
    // Tauri rejects with the serialised error object, but a panic on the
    // Rust side arrives as a bare string, and a transport failure as an
    // Error. All three end up in front of the user.
    expect(errorMessage({ kind: "kubernetes", message: "forbidden" })).toBe(
      "forbidden",
    );
    expect(errorMessage("panicked at 'unwrap on None'")).toBe(
      "panicked at 'unwrap on None'",
    );
    expect(errorMessage(new Error("network unreachable"))).toBe(
      "network unreachable",
    );
    // Never an empty string or "undefined", which read as a broken app
    // rather than as a failure.
    expect(errorMessage(null)).toBe("unexpected error");
    expect(errorMessage(42)).toBe("unexpected error");
  });

  it("does not mistake an arbitrary object for an api error", () => {
    expect(isApiError({ kind: "conflict", message: "x" })).toBe(true);
    expect(isApiError({ kind: "conflict" })).toBe(false);
    expect(isApiError([])).toBe(false);
  });
});


describe("the command list agrees with the Rust side", () => {
  /// The commands `lib.rs` registers, and the ones `api.ts` calls.
  function commandSets() {
    const handler = libRs.match(/generate_handler!\[([\s\S]*?)\]/);
    expect(handler, "generate_handler! not found in lib.rs").not.toBeNull();

    const registered = handler![1]
      .split(",")
      .map((name: string) => name.trim())
      .filter(Boolean);

    // Every `invoke<T>("command_name"` in the wrapper file.
    const called = [
      ...apiTs.matchAll(/invoke<[^>]*>\(\s*"([a-z_]+)"/g),
    ].map((m: RegExpMatchArray) => m[1]);

    return { registered, called };
  }

  it("invokes only commands lib.rs actually registers", () => {
    // The check this file exists for. Nothing else connects these two
    // sets: a command renamed in Rust leaves the string here pointing at
    // nothing, and the app fails at runtime rather than at build time.
    const { registered, called } = commandSets();
    expect(called.length).toBeGreaterThan(20);

    const known = new Set(registered);
    const missing = called.filter((c) => !known.has(c));
    expect(missing, `not registered in lib.rs: ${missing.join(", ")}`).toEqual([]);
  });

  it("leaves no registered command unreachable from the frontend", () => {
    // The other direction. A command nobody calls is either dead code or
    // a feature that was wired up on one side only.
    const { registered, called } = commandSets();
    const used = new Set(called);

    const unused = registered.filter((c) => !used.has(c));
    expect(unused, `registered but never called: ${unused.join(", ")}`).toEqual(
      [],
    );
  });
});
