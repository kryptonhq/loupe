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

/// Pushes a batch of lines, which is the only shape the Rust side sends.
function emitLines(...texts: string[]) {
  emit({ kind: "lines", texts });
}

/// The lines currently in the DOM. Deliberately not "the lines the
/// stream sent" — the gap between the two is the windowing.
function renderedLines() {
  return screen.queryAllByTestId("log-line").map((el) => el.textContent);
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

    emitLines("listening on :8080", "ready");

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

    emitLines("from-app");
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

  // Rendering under load. The old viewer put every retained line in the
  // DOM and rebuilt the whole text node per line, so cost grew with how
  // much output you had already seen. These are the assertions that stop
  // that coming back.

  it("puts only the visible lines in the DOM", async () => {
    renderViewer();
    await waitFor(() => expect(startPodLogs).toHaveBeenCalled());

    emitLines(...Array.from({ length: 6000 }, (_, i) => `line ${i}`));
    await screen.findByText("line 5999");

    // A viewport's worth plus overscan — emphatically not 5,000.
    const rendered = renderedLines();
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(200);
  });

  it("shows the newest lines while following", async () => {
    renderViewer();
    await waitFor(() => expect(startPodLogs).toHaveBeenCalled());

    emitLines(...Array.from({ length: 500 }, (_, i) => `line ${i}`));
    await screen.findByText("line 499");

    // The tail is what a followed stream is for; the head is long gone
    // off the top of the window.
    expect(renderedLines()).toContain("line 499");
    expect(renderedLines()).not.toContain("line 0");
  });

  it("keeps the newest lines once the cap is reached", async () => {
    renderViewer();
    await waitFor(() => expect(startPodLogs).toHaveBeenCalled());

    // Past the 5,000-line cap, so the earliest lines are evicted.
    emitLines(...Array.from({ length: 5200 }, (_, i) => `line ${i}`));
    await screen.findByText("line 5199");

    expect(await screen.findByText(/showing last 5000/)).toBeInTheDocument();
  });

  it("does not claim to be truncating before it is", async () => {
    // The notice is a statement about lost data. Showing it when nothing
    // was dropped teaches people to ignore it.
    renderViewer();
    await waitFor(() => expect(startPodLogs).toHaveBeenCalled());

    emitLines("one", "two");
    await screen.findByText("one");

    expect(screen.queryByText(/showing last/)).not.toBeInTheDocument();
  });

  it("coalesces a burst into a single update", async () => {
    // Each batch from Rust must cost one render, not one per line. The
    // proxy for "one render" is that a burst arriving in one message is
    // all on screen together rather than trickling in.
    renderViewer();
    await waitFor(() => expect(startPodLogs).toHaveBeenCalled());

    emitLines("first", "second", "third");
    await screen.findByText("third");

    expect(renderedLines()).toEqual(["first", "second", "third"]);
  });

  it("drops lines still queued when the stream restarts", async () => {
    // Lines that arrived for the old container must not land under the
    // new one's heading after the switch.
    const user = renderViewer([container("app"), container("sidecar")]);
    await waitFor(() => expect(startPodLogs).toHaveBeenCalledTimes(1));

    // Emitted without awaiting a flush, so they are still queued.
    emitLines("stale-from-app");
    await user.selectOptions(screen.getByRole("combobox"), "sidecar");
    await waitFor(() => expect(startPodLogs).toHaveBeenCalledTimes(2));

    emitLines("fresh-from-sidecar");
    await screen.findByText("fresh-from-sidecar");
    expect(screen.queryByText("stale-from-app")).not.toBeInTheDocument();
  });
});
