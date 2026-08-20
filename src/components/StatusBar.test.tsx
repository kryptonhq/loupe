import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StatusBar } from "./StatusBar";
import type { ClusterInfo, Guard } from "../lib/api";
import type { UpdateState } from "../lib/update";

// The guard is only worth having if it is impossible to miss. It used to
// sit in the foot of the nav rail; these assert it is legible from the
// status bar instead — including in a screenshot, which is where most
// people will first see that this exists.

const CLUSTER: ClusterInfo = {
  context: "prod-eu-west-1",
  server: "https://10.0.0.1:6443",
  version: "v1.34.8",
  platform: "linux/amd64",
};

function setup(
  guard: Guard = "open",
  update: UpdateState = { status: "idle" },
) {
  const onGuardChange = vi.fn();
  const onSwitchCluster = vi.fn();
  const onDisconnect = vi.fn();
  const onUpdate = vi.fn();

  render(
    <StatusBar
      cluster={CLUSTER}
      guard={guard}
      onGuardChange={onGuardChange}
      onSwitchCluster={onSwitchCluster}
      onDisconnect={onDisconnect}
      update={update}
      onUpdate={onUpdate}
    />,
  );
  return {
    onGuardChange,
    onSwitchCluster,
    onDisconnect,
    onUpdate,
    user: userEvent.setup(),
  };
}

describe("StatusBar", () => {
  it("names the cluster and its version", () => {
    setup();
    expect(screen.getByText("prod-eu-west-1")).toBeInTheDocument();
    expect(screen.getByText("v1.34.8")).toBeInTheDocument();
  });

  it("says an ordinary cluster is writable without shouting", () => {
    setup("open");
    expect(screen.getByText("Writes allowed")).toBeInTheDocument();
    expect(screen.queryByText("Read-only")).not.toBeInTheDocument();
  });

  it("marks a read-only cluster", () => {
    setup("readOnly");
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });

  it("marks a protected cluster", () => {
    setup("protected");
    expect(screen.getByText(/Protected/)).toBeInTheDocument();
  });

  it("takes the guard's colour, so a marked cluster reads differently", () => {
    // The point of the safeguard is that you notice it without looking
    // for it. A tint across the whole line does that; a word does not.
    const { container } = render(
      <StatusBar
        cluster={CLUSTER}
        guard="readOnly"
        onGuardChange={vi.fn()}
        onSwitchCluster={vi.fn()}
        onDisconnect={vi.fn()}
        update={{ status: "idle" }}
        onUpdate={vi.fn()}
      />,
    );
    expect(container.querySelector("footer")?.className).toContain("bg-danger");
  });

  it("changes the guard", async () => {
    const { user, onGuardChange } = setup("open");

    await user.selectOptions(
      screen.getByRole("combobox", { name: /What this context allows/ }),
      "readOnly",
    );
    expect(onGuardChange).toHaveBeenCalledWith("readOnly");
  });

  it("switches cluster from the cluster name", async () => {
    // The thing people reach for most after picking the wrong one.
    const { user, onSwitchCluster } = setup();
    await user.click(screen.getByText("prod-eu-west-1"));
    expect(onSwitchCluster).toHaveBeenCalledOnce();
  });

  it("disconnects", async () => {
    const { user, onDisconnect } = setup();
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(onDisconnect).toHaveBeenCalledOnce();
  });
});

// The update segment. It sits beside the running version, and costs
// nothing at all in the case that holds almost every time the app is
// open: there is no new version.
describe("StatusBar updates", () => {
  it("says nothing when there is no update", () => {
    setup();
    expect(screen.queryByText(/Update to/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Restart to finish/)).not.toBeInTheDocument();
  });

  it("offers the new version, and reports the click", async () => {
    const { user, onUpdate } = setup("open", {
      status: "available",
      version: "0.1.6",
      notes: null,
    });

    await user.click(screen.getByText(/Update to 0\.1\.6/));
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it("shows progress, and does not invite a click mid-download", async () => {
    setup("open", { status: "downloading", version: "0.1.6", percent: 40 });
    expect(screen.getByText(/Downloading 0\.1\.6 — 40%/)).toBeInTheDocument();
    // Nothing a second click could usefully do, so no button to press.
    expect(screen.queryByRole("button", { name: /Downloading/ })).not.toBeInTheDocument();
  });

  it("asks for the restart that finishes the job", async () => {
    const { user, onUpdate } = setup("open", { status: "ready", version: "0.1.6" });
    await user.click(screen.getByText(/Restart to finish 0\.1\.6/));
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it("marks a failed install, and lets it be retried", async () => {
    // Unlike a failed check, which stays quiet: this one the user asked
    // for and was waiting on.
    const { user, onUpdate } = setup("open", {
      status: "failed",
      version: "0.1.6",
      message: "network went away",
    });
    const cell = screen.getByText(/Update to 0\.1\.6 failed/);
    expect(cell.className).toContain("text-danger");

    await user.click(cell);
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it("shows the release notes as the tooltip when there are some", () => {
    setup("open", {
      status: "available",
      version: "0.1.6",
      notes: "Sortable columns.",
    });
    expect(screen.getByRole("button", { name: /Update to 0\.1\.6/ })).toHaveAttribute(
      "title",
      "Sortable columns.",
    );
  });
});
