import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LogViewer } from "./LogViewer";
import { api, type ContainerView, type LogEvent } from "../lib/api";

// The log viewer is the only component holding a long-lived resource: a
// followed stream is an open HTTP connection to the API server. Most of
// what is asserted here is about closing them — a leak per view is
// invisible until a session has a hundred of them.

vi.mock("../lib/api", async (original) => {
  const actual = await original<typeof import("../lib/api")>();
  return {
    ...actual,
    // Tauri's own Channel reaches into `window.__TAURI_INTERNALS__`,
    // which only exists inside the webview. The component treats a
    // channel as a thing with an `onmessage`, so that is all the
    // stand-in needs to be. Declared in here because vi.mock's factory
    // is hoisted above anything defined at the top level of the file.
    Channel: class {
      onmessage?: (event: LogEvent) => void;
    },
    api: { ...actual.api, startPodLogs: vi.fn(), stopPodLogs: vi.fn() },
  };
});

const startPodLogs = vi.mocked(api.startPodLogs);
const stopPodLogs = vi.mocked(api.stopPodLogs);

/// Captures the channel each stream was opened with, so a test can push
/// lines down it the way the Rust side would.
let channels: { onmessage?: (e: LogEvent) => void }[] = [];

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

function renderViewer(containers = [container("app")]) {
  render(
    <LogViewer namespace="kube-system" pod="coredns-abc" containers={containers} />,
  );
  return userEvent.setup();
}

/// Pushes an event down the most recently opened channel, the way the
/// Rust side does. Wrapped in `act` because it lands as a state update
/// arriving from outside React.
function emit(event: LogEvent) {
  act(() => {
    channels[channels.length - 1]?.onmessage?.(event);
  });
}

beforeEach(() => {
  channels = [];
  startPodLogs.mockReset();
  stopPodLogs.mockReset();

  let nextId = 1;
  startPodLogs.mockImplementation(async (_options, channel) => {
    channels.push(channel as unknown as { onmessage?: (e: LogEvent) => void });
    return nextId++;
  });
  stopPodLogs.mockResolvedValue(true);
});

describe("LogViewer", () => {
  it("opens a stream for the pod's container", async () => {
    renderViewer();
    await waitFor(() => expect(startPodLogs).toHaveBeenCalled());

    const [options] = startPodLogs.mock.calls[0];
    expect(options.namespace).toBe("kube-system");
    expect(options.pod).toBe("coredns-abc");
    expect(options.container).toBe("app");
    // Without a bound, attaching to a long-running pod dumps its entire
    // retained buffer into the DOM.
    expect(options.tailLines).toBe(500);
  });

  it("renders the lines the stream pushes", async () => {
    renderViewer();
    await waitFor(() => expect(startPodLogs).toHaveBeenCalled());

    emit({ kind: "line", text: "listening on :8080" });
    emit({ kind: "line", text: "ready" });

    expect(await screen.findByText(/listening on :8080/)).toBeInTheDocument();
    expect(screen.getByText(/ready/)).toBeInTheDocument();
  });

  it("says when a stream has ended", async () => {
    // A view that simply stops producing lines is indistinguishable from
    // a quiet pod, which is why the Rust side sends an explicit Ended.
    renderViewer();
    await waitFor(() => expect(startPodLogs).toHaveBeenCalled());

    emit({ kind: "ended" });
    expect(await screen.findByText("ended")).toBeInTheDocument();
  });

  it("surfaces a stream failure rather than going quiet", async () => {
    renderViewer();
    await waitFor(() => expect(startPodLogs).toHaveBeenCalled());

    emit({ kind: "failed", message: "container app is not running" });
    expect(await screen.findByText(/is not running/)).toBeInTheDocument();
  });

  it("surfaces a failure to open the stream at all", async () => {
    // An RBAC denial or a bad container name fails here rather than on
    // the channel, and has to reach the screen the same way.
    startPodLogs.mockRejectedValue({
      kind: "kubernetes",
      message: 'pods/log is forbidden: User "dev" cannot get',
    });

    renderViewer();
    expect(await screen.findByText(/forbidden/)).toBeInTheDocument();
  });

  it("stops the stream when the view goes away", async () => {
    // The leak that matters: a followed stream holds a connection open,
    // and closing the tab must close it.
    const { unmount } = render(
      <LogViewer
        namespace="kube-system"
        pod="coredns-abc"
        containers={[container("app")]}
      />,
    );
    await waitFor(() => expect(startPodLogs).toHaveBeenCalled());

    unmount();
    await waitFor(() => expect(stopPodLogs).toHaveBeenCalledWith(1));
  });

  it("stops the old stream before it starts a new one", async () => {
    // Toggling an option restarts the stream. Without the teardown each
    // toggle would leave the previous one running.
    const user = renderViewer();
    await waitFor(() => expect(startPodLogs).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("checkbox", { name: /Timestamps/ }));

    await waitFor(() => expect(startPodLogs).toHaveBeenCalledTimes(2));
    expect(stopPodLogs).toHaveBeenCalledWith(1);
    expect(startPodLogs.mock.calls[1][0].timestamps).toBe(true);
  });

  it("reads the previous container instance when asked", async () => {
    // The only way to see why a CrashLoopBackOff pod died, so the flag
    // has to reach the command rather than only the checkbox.
    const user = renderViewer();
    await waitFor(() => expect(startPodLogs).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("checkbox", { name: /Previous/ }));
    await waitFor(() => expect(startPodLogs).toHaveBeenCalledTimes(2));
    expect(startPodLogs.mock.calls[1][0].previous).toBe(true);
  });

  it("clears the previous container's lines when switching", async () => {
    // Otherwise one container's output appears under another's name,
    // which is worse than showing nothing.
    const user = renderViewer([container("app"), container("sidecar")]);
    await waitFor(() => expect(startPodLogs).toHaveBeenCalledTimes(1));

    emit({ kind: "line", text: "from-app" });
    await screen.findByText(/from-app/);

    await user.selectOptions(screen.getByRole("combobox"), "sidecar");
    await waitFor(() => expect(startPodLogs).toHaveBeenCalledTimes(2));

    expect(screen.queryByText(/from-app/)).not.toBeInTheDocument();
    expect(startPodLogs.mock.calls[1][0].container).toBe("sidecar");
  });

  it("offers no container picker for a single-container pod", () => {
    // The overwhelmingly common case; a select with one option is noise.
    renderViewer();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("says so when a container produced nothing", async () => {
    renderViewer();
    await waitFor(() => expect(startPodLogs).toHaveBeenCalled());

    emit({ kind: "ended" });
    expect(await screen.findByText("No output.")).toBeInTheDocument();
  });

  it("follows by default", async () => {
    // Opening logs on a running pod and watching nothing arrive is a
    // confusing first impression.
    renderViewer();
    await waitFor(() => expect(startPodLogs).toHaveBeenCalled());
    expect(startPodLogs.mock.calls[0][0].follow).toBe(true);
    expect(screen.getByRole("checkbox", { name: /Follow/ })).toBeChecked();
  });
});
