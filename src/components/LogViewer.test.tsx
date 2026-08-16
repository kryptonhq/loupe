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
    api: {
      ...actual.api,
      startPodLogs: vi.fn(),
      startMergedLogs: vi.fn(),
      stopPodLogs: vi.fn(),
      saveText: vi.fn(),
    },
  };
});

const startPodLogs = vi.mocked(api.startPodLogs);
const stopPodLogs = vi.mocked(api.stopPodLogs);
const saveText = vi.mocked(api.saveText);
const startMergedLogs = vi.mocked(api.startMergedLogs);

/// jsdom has no clipboard. Stands in for one, and records what was put
/// on it so the export can be asserted against.
const clipboard = { text: "" };

/// Installs the stand-in. Must run *after* `userEvent.setup()`, which
/// installs a clipboard stub of its own and would otherwise win.
function stubClipboard(writeText?: () => Promise<never>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText:
        writeText ??
        (async (text: string) => {
          clipboard.text = text;
        }),
    },
  });
}

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
  const user = userEvent.setup();
  stubClipboard();
  return user;
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

/// Renders a merged view over a selector rather than a single pod.
function renderMerged(selector = "app=api") {
  render(
    <LogViewer
      namespace="payments"
      pod=""
      containers={[container("app")]}
      selector={selector}
      workload="Deployment api"
    />,
  );
  const user = userEvent.setup();
  stubClipboard();
  return user;
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
  saveText.mockReset();
  saveText.mockResolvedValue("/tmp/coredns.log");
  startMergedLogs.mockReset();

  clipboard.text = "";

  let nextId = 1;
  startPodLogs.mockImplementation(async (_options, channel) => {
    channels.push(channel as unknown as { onmessage?: (e: LogEvent) => void });
    return nextId++;
  });
  startMergedLogs.mockImplementation(async (_options, channel) => {
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

    await user.selectOptions(screen.getByRole("combobox", { name: "Container" }), "sidecar");
    await waitFor(() => expect(startPodLogs).toHaveBeenCalledTimes(2));

    expect(screen.queryByText(/from-app/)).not.toBeInTheDocument();
    expect(startPodLogs.mock.calls[1][0].container).toBe("sidecar");
  });

  it("offers no container picker for a single-container pod", () => {
    // The overwhelmingly common case; a select with one option is noise.
    renderViewer();
    expect(
      screen.queryByRole("combobox", { name: "Container" }),
    ).not.toBeInTheDocument();
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

  // Filtering. All of it is display-only: narrowing a running log must
  // never restart the stream, or the lines you were reading vanish and
  // the ones that arrived while you typed are lost.

  it("narrows to matching lines without touching the stream", async () => {
    const user = renderViewer();
    await waitFor(() => expect(startPodLogs).toHaveBeenCalledTimes(1));

    emitLines("GET /api 200", "GET /healthz 200", "GET /api 500");
    await screen.findByText("GET /api 200");

    await user.type(screen.getByLabelText("Filter lines"), "/api");

    await waitFor(() => expect(renderedLines()).toHaveLength(2));
    expect(renderedLines()).toEqual(["GET /api 200", "GET /api 500"]);
    // The stream is untouched: one call, still the original.
    expect(startPodLogs).toHaveBeenCalledTimes(1);
  });

  it("keeps filtering lines that arrive after the filter is set", async () => {
    const user = renderViewer();
    await waitFor(() => expect(startPodLogs).toHaveBeenCalled());

    emitLines("keep me");
    await screen.findByText("keep me");
    await user.type(screen.getByLabelText("Filter lines"), "keep");

    emitLines("drop me", "keep me too");
    await waitFor(() => expect(renderedLines()).toHaveLength(2));

    expect(renderedLines()).toEqual(["keep me", "keep me too"]);
  });

  it("hides lines matching the exclusion", async () => {
    const user = renderViewer();
    await waitFor(() => expect(startPodLogs).toHaveBeenCalled());

    emitLines("request /api", "request /healthz");
    await screen.findByText("request /api");

    await user.type(screen.getByLabelText("Exclude lines"), "healthz");

    await waitFor(() => expect(renderedLines()).toHaveLength(1));
    expect(renderedLines()).toEqual(["request /api"]);
  });

  it("marks the matched text inside the line", async () => {
    // With context lines on, surviving the filter is no longer enough to
    // tell you which line actually matched.
    const user = renderViewer();
    await waitFor(() => expect(startPodLogs).toHaveBeenCalled());

    emitLines("level=error msg=boom");
    await screen.findByText(/level=/);

    await user.type(screen.getByLabelText("Filter lines"), "error");

    const marked = await screen.findByText("error", { selector: "mark" });
    expect(marked).toBeInTheDocument();
  });

  it("shows the lines around a match when context is asked for", async () => {
    const user = renderViewer();
    await waitFor(() => expect(startPodLogs).toHaveBeenCalled());

    emitLines("before", "the failure", "after", "unrelated", "unrelated");
    await screen.findByText("before");

    await user.type(screen.getByLabelText("Filter lines"), "failure");
    await waitFor(() => expect(renderedLines()).toEqual(["the failure"]));

    await user.selectOptions(
      screen.getByRole("combobox", { name: /context/i }),
      "2",
    );

    await waitFor(() =>
      expect(renderedLines()).toEqual([
        "before",
        "the failure",
        "after",
        "unrelated",
      ]),
    );
  });

  it("counts the matches against what it is holding", async () => {
    const user = renderViewer();
    await waitFor(() => expect(startPodLogs).toHaveBeenCalled());

    emitLines("hit", "miss", "hit");
    await screen.findByText("miss");

    await user.type(screen.getByLabelText("Filter lines"), "hit");
    expect(await screen.findByText("2 of 3")).toBeInTheDocument();
  });

  it("says so when a filter matches nothing", async () => {
    // Distinct from "No output." — the pod said plenty, the filter is
    // simply too narrow, and conflating the two sends people looking for
    // a problem in the wrong place.
    const user = renderViewer();
    await waitFor(() => expect(startPodLogs).toHaveBeenCalled());

    emitLines("something");
    await screen.findByText("something");

    await user.type(screen.getByLabelText("Filter lines"), "nothing matches this");
    expect(await screen.findByText("No lines match.")).toBeInTheDocument();
  });

  it("reports an invalid regex and keeps showing the log", async () => {
    // A regex is invalid for most of the time it is being typed. Going
    // blank on every keystroke is unusable, and reads as a dead pod.
    const user = renderViewer();
    await waitFor(() => expect(startPodLogs).toHaveBeenCalled());

    emitLines("still here");
    await screen.findByText("still here");

    await user.click(screen.getByRole("checkbox", { name: /Regex/ }));
    await user.type(screen.getByLabelText("Filter lines"), "GET /(health");

    expect(await screen.findByText(/Not a valid pattern/)).toBeInTheDocument();
    expect(renderedLines()).toEqual(["still here"]);
  });

  it("treats a plain filter as text, not as a pattern", async () => {
    // Log lines are full of regex metacharacters. Typing an IP address
    // should find that IP address.
    const user = renderViewer();
    await waitFor(() => expect(startPodLogs).toHaveBeenCalled());

    emitLines("peer 10.0.0.1 up", "peer 10x0y0z1 up");
    await screen.findByText(/10\.0\.0\.1/);

    await user.type(screen.getByLabelText("Filter lines"), "10.0.0.1");

    await waitFor(() => expect(renderedLines()).toHaveLength(1));
    expect(renderedLines()).toEqual(["peer 10.0.0.1 up"]);
  });

  // Getting the output back out. A debugging tool that cannot hand you
  // the evidence sends you to a terminal at the last step.

  it("copies the lines with a header saying where they came from", async () => {
    const user = renderViewer();
    await waitFor(() => expect(startPodLogs).toHaveBeenCalled());

    emitLines("first", "second");
    await screen.findByText("first");

    await user.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(clipboard.text).not.toBe(""));
    expect(clipboard.text).toContain("kube-system/coredns-abc");
    expect(clipboard.text).toContain("first\nsecond");
  });

  it("saves under a name derived from the pod and container", async () => {
    const user = renderViewer();
    await waitFor(() => expect(startPodLogs).toHaveBeenCalled());

    emitLines("something");
    await screen.findByText("something");

    await user.click(screen.getByRole("button", { name: "Save…" }));

    await waitFor(() => expect(saveText).toHaveBeenCalled());
    const [name, body] = saveText.mock.calls[0];
    expect(name).toMatch(/^coredns-abc-app-\d{8}-\d{6}\.log$/);
    expect(body).toContain("something");
  });

  it("exports what the filter left, and says that it did", async () => {
    // Saving a filtered view without recording the filter would produce
    // a file that misleads whoever opens it later.
    const user = renderViewer();
    await waitFor(() => expect(startPodLogs).toHaveBeenCalled());

    emitLines("keep this", "drop this");
    await screen.findByText("keep this");
    await user.type(screen.getByLabelText("Filter lines"), "keep");
    await waitFor(() => expect(renderedLines()).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(clipboard.text).not.toBe(""));

    expect(clipboard.text).toContain("keep this");
    expect(clipboard.text).not.toContain("drop this");
    expect(clipboard.text).toContain("filter:");
    expect(clipboard.text).toContain("1 of 2");
  });

  it("confirms a save with the path it wrote", async () => {
    const user = renderViewer();
    await waitFor(() => expect(startPodLogs).toHaveBeenCalled());
    emitLines("a line");
    await screen.findByText("a line");

    await user.click(screen.getByRole("button", { name: "Save…" }));
    expect(await screen.findByText(/\/tmp\/coredns\.log/)).toBeInTheDocument();
  });

  it("says nothing when the user cancels the save dialog", async () => {
    // Cancelling is an ordinary outcome, not a failure to report.
    saveText.mockResolvedValue(null);

    const user = renderViewer();
    await waitFor(() => expect(startPodLogs).toHaveBeenCalled());
    emitLines("a line");
    await screen.findByText("a line");

    await user.click(screen.getByRole("button", { name: "Save…" }));
    await waitFor(() => expect(saveText).toHaveBeenCalled());

    expect(screen.queryByText(/Saved/)).not.toBeInTheDocument();
  });

  it("reports a failed save rather than appearing to have worked", async () => {
    saveText.mockRejectedValue({
      kind: "export",
      message: "write /read-only/x.log: permission denied",
    });

    const user = renderViewer();
    await waitFor(() => expect(startPodLogs).toHaveBeenCalled());
    emitLines("a line");
    await screen.findByText("a line");

    await user.click(screen.getByRole("button", { name: "Save…" }));
    expect(await screen.findByText(/permission denied/)).toBeInTheDocument();
  });

  it("says so when the clipboard cannot be reached", async () => {
    // A button that silently does nothing is worse than one that fails.
    const user = renderViewer();
    stubClipboard(() => Promise.reject(new Error("denied")));
    await waitFor(() => expect(startPodLogs).toHaveBeenCalled());
    emitLines("a line");
    await screen.findByText("a line");

    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByText(/Could not reach the clipboard/)).toBeInTheDocument();
  });

  it("offers nothing to export when there is no output", async () => {
    renderViewer();
    await waitFor(() => expect(startPodLogs).toHaveBeenCalled());
    emit({ kind: "ended" });

    expect(await screen.findByRole("button", { name: "Copy" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save…" })).toBeDisabled();
  });

  it("drops lines still queued when the stream restarts", async () => {
    // Lines that arrived for the old container must not land under the
    // new one's heading after the switch.
    const user = renderViewer([container("app"), container("sidecar")]);
    await waitFor(() => expect(startPodLogs).toHaveBeenCalledTimes(1));

    // Emitted without awaiting a flush, so they are still queued.
    emitLines("stale-from-app");
    await user.selectOptions(screen.getByRole("combobox", { name: "Container" }), "sidecar");
    await waitFor(() => expect(startPodLogs).toHaveBeenCalledTimes(2));

    emitLines("fresh-from-sidecar");
    await screen.findByText("fresh-from-sidecar");
    expect(screen.queryByText("stale-from-app")).not.toBeInTheDocument();
  });
});

// Merging several pods into one view. A Deployment's logs *are* the
// interleaved logs of its replicas, and reading them one pod at a time
// is the slowest way to find the one that differs — which is why stern
// exists, and why this needs to be legible rather than just correct.
describe("LogViewer merged", () => {
  it("streams by selector rather than by pod", async () => {
    renderMerged("app=api");
    await waitFor(() => expect(startMergedLogs).toHaveBeenCalled());

    const [options] = startMergedLogs.mock.calls[0];
    expect(options.selector).toBe("app=api");
    expect(options.namespace).toBe("payments");
    // The single-pod path must not also fire.
    expect(startPodLogs).not.toHaveBeenCalled();
  });

  it("marks each line with the pod it came from", async () => {
    renderMerged();
    await waitFor(() => expect(startMergedLogs).toHaveBeenCalled());

    emit({ kind: "podStarted", pod: "api-7d9-aaa" });
    emit({ kind: "lines", texts: ["listening"], source: "api-7d9-aaa" });

    await screen.findByText(/listening/);
    const sources = screen.getAllByTestId("log-source");
    expect(sources[0].textContent).toContain("api-7d9-aaa");
  });

  it("gives different pods different colours", async () => {
    // Twelve interleaved streams are scanned rather than read: the
    // colour says "different replica" before the name is parsed.
    renderMerged();
    await waitFor(() => expect(startMergedLogs).toHaveBeenCalled());

    emit({ kind: "podStarted", pod: "api-a" });
    emit({ kind: "podStarted", pod: "api-b" });
    emit({ kind: "lines", texts: ["from a"], source: "api-a" });
    emit({ kind: "lines", texts: ["from b"], source: "api-b" });

    await screen.findByText(/from b/);
    const [first, second] = screen.getAllByTestId("log-source");
    expect(first.className).not.toBe(second.className);
  });

  it("does not prefix anything in a single-pod view", async () => {
    // A pod name on every line of a single-pod log is pure noise, and
    // costs a chunk of every line's width.
    renderViewer();
    await waitFor(() => expect(startPodLogs).toHaveBeenCalled());
    emitLines("plain");

    await screen.findByText(/plain/);
    expect(screen.queryAllByTestId("log-source")).toHaveLength(0);
  });

  it("lists the pods it is following", async () => {
    renderMerged();
    await waitFor(() => expect(startMergedLogs).toHaveBeenCalled());

    emit({ kind: "podStarted", pod: "api-a" });
    emit({ kind: "podStarted", pod: "api-b" });

    // The heading also carries the workload name, so match loosely.
    expect(await screen.findByText(/2 pods/)).toBeInTheDocument();
  });

  it("keeps going when one pod's stream ends", async () => {
    // During a rollout, old replicas finish while new ones start. One
    // ending must not read as the whole view being over.
    renderMerged();
    await waitFor(() => expect(startMergedLogs).toHaveBeenCalled());

    emit({ kind: "podStarted", pod: "api-old" });
    emit({ kind: "lines", texts: ["last words"], source: "api-old" });
    emit({ kind: "podEnded", pod: "api-old" });

    await screen.findByText(/last words/);
    expect(screen.queryByText("ended")).not.toBeInTheDocument();
  });

  it("picks up a replica that appears during a rollout", async () => {
    renderMerged();
    await waitFor(() => expect(startMergedLogs).toHaveBeenCalled());

    emit({ kind: "podStarted", pod: "api-old" });
    emit({ kind: "podEnded", pod: "api-old" });
    emit({ kind: "podStarted", pod: "api-new" });
    emit({ kind: "lines", texts: ["hello from the new one"], source: "api-new" });

    expect(await screen.findByText(/hello from the new one/)).toBeInTheDocument();
  });

  it("says when more pods match than are being streamed", async () => {
    // A merged view quietly missing half the replicas is worse than one
    // that admits it — the whole point is finding the replica that
    // differs, and it might be one of the missing ones.
    renderMerged();
    await waitFor(() => expect(startMergedLogs).toHaveBeenCalled());

    emit({ kind: "capped", streaming: 20, matched: 240 });

    expect(
      await screen.findByText(/showing 20 of 240 matching pods/),
    ).toBeInTheDocument();
  });

  it("filters on the log text, not on the pod name", async () => {
    // Otherwise typing a replica's name silently becomes a pod filter,
    // which is a different feature wearing the same box.
    renderMerged();
    await waitFor(() => expect(startMergedLogs).toHaveBeenCalled());

    emit({ kind: "podStarted", pod: "api-error-handler" });
    emit({ kind: "lines", texts: ["all fine here"], source: "api-error-handler" });
    await screen.findByText(/all fine here/);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Filter lines"), "error");

    await waitFor(() => expect(renderedLines()).toHaveLength(0));
  });
});
