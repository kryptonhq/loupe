import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { Terminal } from "./Terminal";
import { ClusterContext } from "../lib/clusterContext";
import { api, type ContainerView, type ExecEvent, type Guard } from "../lib/api";

// A shell is the most privileged thing this app opens, so most of what
// is asserted here is about closing one: a leaked session is a leaked
// connection *and* a process still running in somebody's container.
//
// The emulator itself is xterm's problem, not ours. What is ours is the
// wiring — every keystroke reaching Rust as raw bytes, every byte coming
// back untouched, and the size staying in step — so xterm is stubbed and
// those four things are checked directly.

const written: string[] = [];
let onData: ((data: string) => void) | null = null;
const cleared = { count: 0 };

/// Stands in for the emulator. The emulator is xterm's problem; what is
/// ours is the wiring — keystrokes reaching Rust as raw bytes, bytes
/// coming back untouched, and the size staying in step.
const instance = {
  cols: 80,
  rows: 24,
  write: (data: string) => written.push(data),
  focus: vi.fn(),
  clear: () => {
    cleared.count += 1;
  },
};

/// Stable across renders, the way a real ref is. Handing back a fresh
/// object each render would restart the session on every render, which
/// is a fault in the harness rather than in the component — but it is
/// also exactly what the component must not be sensitive to.
const mountRef = { current: null as HTMLDivElement | null };

/// Counts how many times the real hook would have rebuilt the terminal.
///
/// `useXTerm` keys its effects on `[options, addons]` and `[listeners]`,
/// so a fresh object literal on each render rebuilds the terminal on
/// each render — and because rebuilding sets state, that is an infinite
/// loop. Mirroring that here is what turns a hang in the app into a
/// failing assertion.
const built = { count: 0 };
let lastOptions: unknown;
let lastAddons: unknown;
let lastListeners: unknown;

vi.mock("react-xtermjs", () => ({
  useXTerm: ({
    options,
    addons,
    listeners,
  }: {
    options?: unknown;
    addons?: unknown;
    listeners?: { onData?: (d: string) => void };
  }) => {
    if (options !== lastOptions || addons !== lastAddons) {
      lastOptions = options;
      lastAddons = addons;
      built.count += 1;
    }
    lastListeners = listeners;
    onData = listeners?.onData ?? null;
    return { ref: mountRef, instance };
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = vi.fn();
  },
}));

vi.mock("../lib/api", async (original) => {
  const actual = await original<typeof import("../lib/api")>();
  return {
    ...actual,
    Channel: class {
      onmessage?: (event: ExecEvent) => void;
    },
    api: {
      ...actual.api,
      startExec: vi.fn(),
      writeExec: vi.fn(),
      resizeExec: vi.fn(),
      closeExec: vi.fn(),
    },
  };
});

const startExec = vi.mocked(api.startExec);
const writeExec = vi.mocked(api.writeExec);
const resizeExec = vi.mocked(api.resizeExec);
const closeExec = vi.mocked(api.closeExec);

let channels: { onmessage?: (e: ExecEvent) => void }[] = [];

function container(name: string): ContainerView {
  return {
    name,
    image: `${name}:1.0`,
    ready: true,
    restarts: 0,
    state: "Running",
    lastState: null,
  };
}

function setup({
  containers = [container("app")],
  guard = "open" as Guard,
} = {}) {
  const view = render(
    <ClusterContext.Provider value={{ context: "kind-local", guard }}>
      <Terminal namespace="payments" pod="api-7d9" containers={containers} />
    </ClusterContext.Provider>,
  );
  return { unmount: view.unmount };
}

function emit(event: ExecEvent) {
  act(() => {
    channels[channels.length - 1]?.onmessage?.(event);
  });
}

/// What the user's keyboard would produce, delivered the way xterm
/// delivers it: raw bytes, not a line.
function type(data: string) {
  act(() => onData?.(data));
}

beforeEach(() => {
  channels = [];
  written.length = 0;
  cleared.count = 0;
  onData = null;
  built.count = 0;
  lastOptions = undefined;
  lastAddons = undefined;
  lastListeners = undefined;

  startExec.mockReset();
  writeExec.mockReset();
  resizeExec.mockReset();
  closeExec.mockReset();

  let nextId = 1;
  startExec.mockImplementation(async (_options, channel) => {
    channels.push(channel as unknown as { onmessage?: (e: ExecEvent) => void });
    return nextId++;
  });
  writeExec.mockResolvedValue(undefined);
  resizeExec.mockResolvedValue(undefined);
  closeExec.mockResolvedValue(true);
});

describe("Terminal", () => {
  it("opens a shell in the pod's container", async () => {
    setup();
    await waitFor(() => expect(startExec).toHaveBeenCalled());

    const [options] = startExec.mock.calls[0];
    expect(options.namespace).toBe("payments");
    expect(options.pod).toBe("api-7d9");
    expect(options.container).toBe("app");
    // Null means "probe for one", which is the default behaviour.
    expect(options.shell).toBeNull();
  });

  it("says which shell it actually got", async () => {
    // The probe may have fallen back, and which shell you are in changes
    // what you can type into it.
    setup();
    await waitFor(() => expect(startExec).toHaveBeenCalled());

    emit({ kind: "started", shell: "/bin/sh" });
    expect(await screen.findByText("/bin/sh")).toBeInTheDocument();
  });

  it("writes output through untouched", async () => {
    // Including the escape sequences. Interpreting them is the whole
    // reason this is an emulator rather than a text box — the version
    // that stripped them by hand mangled ordinary output instead.
    setup();
    await waitFor(() => expect(startExec).toHaveBeenCalled());

    emit({ kind: "started", shell: "/bin/sh" });
    emit({ kind: "output", data: "[31merror[0m [INFO] done]\r\n" });

    expect(written).toContain("[31merror[0m [INFO] done]\r\n");
  });

  it("sends a keystroke the moment it is typed", async () => {
    // Not on Enter. A shell needs the bytes as they happen, which is
    // what makes tab completion and Ctrl-R work at all.
    setup();
    await waitFor(() => expect(startExec).toHaveBeenCalled());
    emit({ kind: "started", shell: "/bin/sh" });

    type("l");
    await waitFor(() => expect(writeExec).toHaveBeenCalledWith(1, "l"));
  });

  it("sends control sequences the old input box could not", async () => {
    setup();
    await waitFor(() => expect(startExec).toHaveBeenCalled());
    emit({ kind: "started", shell: "/bin/sh" });

    // Ctrl-C, Tab, and an arrow key: none of these are "a line of text".
    type("");
    type("\t");
    type("[A");

    const sent = writeExec.mock.calls.map(([, data]) => data);
    expect(sent).toEqual(["", "\t", "[A"]);
  });

  it("tells the remote TTY how big the window is", async () => {
    // Without this, everything full-screen in the container draws for
    // 80x24 whatever the pane is.
    setup();
    await waitFor(() => expect(startExec).toHaveBeenCalled());
    emit({ kind: "started", shell: "/bin/sh" });

    await waitFor(() => expect(resizeExec).toHaveBeenCalled());
    const [id, cols, rows] =
      resizeExec.mock.calls[resizeExec.mock.calls.length - 1];
    expect(id).toBe(1);
    expect(cols).toBeGreaterThan(0);
    expect(rows).toBeGreaterThan(0);
  });

  it("does not send keystrokes before the session exists", async () => {
    // xterm is live as soon as it is mounted, and a keystroke landing
    // before the id arrives would be written to the wrong session or
    // throw.
    // Never resolves, so the session id never arrives.
    startExec.mockReturnValue(new Promise(() => {}));

    setup();
    await waitFor(() => expect(onData).not.toBeNull());

    type("x");
    expect(writeExec).not.toHaveBeenCalled();
  });

  it("closes the session and the terminal when the tab goes away", async () => {
    // The leak that matters: a process still running in a container.
    const { unmount } = setup();
    await waitFor(() => expect(startExec).toHaveBeenCalled());

    unmount();
    await waitFor(() => expect(closeExec).toHaveBeenCalledWith(1));
    // Cleared too, so one container's output cannot appear under the
    // next one's name.
    expect(cleared.count).toBe(1);
  });

  it("closes the old session before opening a new one", async () => {
    setup({ containers: [container("app"), container("sidecar")] });
    await waitFor(() => expect(startExec).toHaveBeenCalledTimes(1));

    const picker = screen.getByRole("combobox", { name: "Container" });
    act(() => {
      Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        "value",
      )!.set!.call(picker, "sidecar");
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await waitFor(() => expect(startExec).toHaveBeenCalledTimes(2));
    expect(closeExec).toHaveBeenCalledWith(1);
    expect(startExec.mock.calls[1][0].container).toBe("sidecar");
  });

  it("explains a distroless image rather than going quiet", async () => {
    startExec.mockRejectedValue({
      kind: "kubernetes",
      message:
        "No shell in this image (tried /bin/bash, /bin/sh, /busybox/sh). Distroless and scratch images ship none",
    });

    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("No shell in this image");
  });

  it("surfaces an RBAC denial", async () => {
    startExec.mockRejectedValue({
      kind: "kubernetes",
      message: 'pods "api-7d9" is forbidden: User "dev" cannot create pods/exec',
    });

    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("forbidden");
  });

  it("says when the remote process exits", async () => {
    setup();
    await waitFor(() => expect(startExec).toHaveBeenCalled());

    emit({ kind: "started", shell: "/bin/sh" });
    emit({ kind: "ended" });

    expect(await screen.findByText("closed")).toBeInTheDocument();
    // And says so in the terminal too, where the user is looking.
    expect(written.join("")).toContain("process exited");
  });

  it("offers no terminal at all on a read-only context", () => {
    // A shell is a write however it is used.
    setup({ guard: "readOnly" });

    expect(screen.queryByTestId("terminal")).not.toBeInTheDocument();
    expect(screen.getByText(/read-only/)).toBeInTheDocument();
    expect(startExec).not.toHaveBeenCalled();
  });

  it("builds the terminal once, however many times it renders", async () => {
    // Regression. Every argument to useXTerm has to keep its identity:
    // the hook rebuilds on `[options, addons]` and re-binds on
    // `[listeners]`, so fresh literals rebuild on every render, and
    // because rebuilding sets state that is an infinite loop. It
    // presented as a terminal stuck on "opening", a pane that never
    // painted, and exec sessions churned against the cluster as fast as
    // React could render.
    setup();
    await waitFor(() => expect(startExec).toHaveBeenCalled());

    // Several state changes, each one a render.
    emit({ kind: "started", shell: "/bin/sh" });
    emit({ kind: "output", data: "hello" });
    emit({ kind: "output", data: " again" });

    expect(built.count).toBe(1);
    expect(startExec).toHaveBeenCalledTimes(1);
  });

  it("keeps the keystroke handler's identity across renders", async () => {
    // Same hazard, different effect: a new `listeners` object re-binds
    // xterm's data handler on every render.
    setup();
    await waitFor(() => expect(startExec).toHaveBeenCalled());
    const first = lastListeners;

    emit({ kind: "started", shell: "/bin/sh" });
    emit({ kind: "output", data: "a render or two later" });

    expect(lastListeners).toBe(first);
  });

  it("reaches a settled state rather than reopening forever", async () => {
    // The symptom the user saw: stuck on "opening a shell…" because the
    // session restarted before it could report itself open.
    setup();
    await waitFor(() => expect(startExec).toHaveBeenCalled());
    emit({ kind: "started", shell: "/bin/sh" });

    expect(await screen.findByText("/bin/sh")).toBeInTheDocument();
    expect(screen.queryByText("opening a shell…")).not.toBeInTheDocument();
  });

  it("does not offer a shell in an init container", async () => {
    // They have already exited; there is nothing to exec into.
    setup({ containers: [container("app")] });
    await waitFor(() => expect(startExec).toHaveBeenCalled());
    expect(
      screen.queryByRole("combobox", { name: "Container" }),
    ).not.toBeInTheDocument();
  });
});
