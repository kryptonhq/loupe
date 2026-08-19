import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StatusBar } from "./StatusBar";
import type { ClusterInfo, Guard } from "../lib/api";

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

function setup(guard: Guard = "open") {
  const onGuardChange = vi.fn();
  const onSwitchCluster = vi.fn();
  const onDisconnect = vi.fn();

  render(
    <StatusBar
      cluster={CLUSTER}
      guard={guard}
      onGuardChange={onGuardChange}
      onSwitchCluster={onSwitchCluster}
      onDisconnect={onDisconnect}
    />,
  );
  return {
    onGuardChange,
    onSwitchCluster,
    onDisconnect,
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
