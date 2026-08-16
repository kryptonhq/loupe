import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Terminal, stripAnsi } from "./Terminal";
import { ClusterContext } from "../lib/clusterContext";
import { api, type ContainerView, type ExecEvent, type Guard } from "../lib/api";

// A shell is the most privileged thing this app opens, so most of what
// is asserted here is about closing one: a leaked session is a leaked
// connection *and* a process still running in somebody's container.

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
  return { user: userEvent.setup(), unmount: view.unmount };
}

function emit(event: ExecEvent) {
  act(() => {
    channels[channels.length - 1]?.onmessage?.(event);
  });
}

beforeEach(() => {
  channels = [];
  startExec.mockReset();
  writeExec.mockReset();
  closeExec.mockReset();

  let nextId = 1;
  startExec.mockImplementation(async (_options, channel) => {
    channels.push(channel as unknown as { onmessage?: (e: ExecEvent) => void });
    return nextId++;
  });
  writeExec.mockResolvedValue(undefined);
  vi.mocked(api.resizeExec).mockResolvedValue(undefined);
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

  it("shows the output the shell produces", async () => {
    setup();
    await waitFor(() => expect(startExec).toHaveBeenCalled());

    emit({ kind: "started", shell: "/bin/sh" });
    emit({ kind: "output", data: "total 0\ndrwxr-xr-x app\n" });

    expect(await screen.findByText(/drwxr-xr-x app/)).toBeInTheDocument();
  });

  it("sends what is typed, with a newline", async () => {
    const { user } = setup();
    await waitFor(() => expect(startExec).toHaveBeenCalled());
    emit({ kind: "started", shell: "/bin/sh" });

    await user.type(await screen.findByLabelText("Terminal input"), "ls -la");
    await user.keyboard("{Enter}");

    await waitFor(() => expect(writeExec).toHaveBeenCalledWith(1, "ls -la\n"));
  });

  it("clears the input once a command is sent", async () => {
    const { user } = setup();
    await waitFor(() => expect(startExec).toHaveBeenCalled());
    emit({ kind: "started", shell: "/bin/sh" });

    const field = await screen.findByLabelText("Terminal input");
    await user.type(field, "whoami");
    await user.keyboard("{Enter}");

    expect(field).toHaveValue("");
  });

  it("sends an interrupt on Ctrl-C rather than copying", async () => {
    // There is nothing else Ctrl-C can usefully mean in a terminal.
    const { user } = setup();
    await waitFor(() => expect(startExec).toHaveBeenCalled());
    emit({ kind: "started", shell: "/bin/sh" });

    // Focused first: the binding is on the input, not on the window,
    // so Ctrl-C elsewhere in the app still copies.
    await user.click(await screen.findByLabelText("Terminal input"));
    await user.keyboard("{Control>}c{/Control}");

    await waitFor(() => expect(writeExec).toHaveBeenCalledWith(1, ""));
  });

  it("closes the session when the tab goes away", async () => {
    // The leak that matters: a process still running in a container.
    const { unmount } = setup();
    await waitFor(() => expect(startExec).toHaveBeenCalled());

    unmount();
    await waitFor(() => expect(closeExec).toHaveBeenCalledWith(1));
  });

  it("closes the old session before opening a new one", async () => {
    const { user } = setup({
      containers: [container("app"), container("sidecar")],
    });
    await waitFor(() => expect(startExec).toHaveBeenCalledTimes(1));

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Container" }),
      "sidecar",
    );

    await waitFor(() => expect(startExec).toHaveBeenCalledTimes(2));
    expect(closeExec).toHaveBeenCalledWith(1);
    expect(startExec.mock.calls[1][0].container).toBe("sidecar");
  });

  it("explains a distroless image rather than going quiet", async () => {
    startExec.mockRejectedValue({
      kind: "kubernetes",
      message:
        "/bin/bash is not in this image. Distroless and scratch images ship no shell at all",
    });

    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("Distroless");
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
    expect(screen.getByLabelText("Terminal input")).toBeDisabled();
  });

  it("offers no terminal at all on a read-only context", () => {
    // A shell is a write however it is used.
    setup({ guard: "readOnly" });

    expect(screen.queryByLabelText("Terminal input")).not.toBeInTheDocument();
    expect(screen.getByText(/read-only/)).toBeInTheDocument();
    expect(startExec).not.toHaveBeenCalled();
  });

  it("does not offer a shell in an init container", async () => {
    // They have already exited; there is nothing to exec into.
    setup({ containers: [container("app")] });
    await waitFor(() => expect(startExec).toHaveBeenCalled());
    expect(screen.queryByRole("combobox", { name: "Container" })).not.toBeInTheDocument();
  });
});

describe("stripAnsi", () => {
  it("removes colour sequences", () => {
    // Left in, they render as visible gibberish; interpreting them
    // properly means an emulator, which is a much bigger thing.
    expect(stripAnsi("[31merror[0m")).toBe("error");
  });

  it("removes cursor movement", () => {
    expect(stripAnsi("a[2Kb")).toBe("ab");
  });

  it("removes a window title sequence", () => {
    expect(stripAnsi("]0;titlels")).toBe("ls");
  });

  it("turns a bare carriage return into a line break", () => {
    // A progress bar redrawing in place. Without an emulator, a break is
    // the least-wrong thing to do with it.
    expect(stripAnsi("50%\r100%")).toBe("50%\n100%");
  });

  it("does not double up a CRLF", () => {
    expect(stripAnsi("one\r\ntwo")).toBe("one\ntwo");
  });

  it("leaves ordinary text alone", () => {
    expect(stripAnsi("total 0\ndrwxr-xr-x  2 root root")).toBe(
      "total 0\ndrwxr-xr-x  2 root root",
    );
  });

  it("leaves an empty string empty", () => {
    expect(stripAnsi("")).toBe("");
  });
});
