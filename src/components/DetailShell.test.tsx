import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DetailShell } from "./DetailShell";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "yaml", label: "YAML" },
];

function setup(tab = "overview") {
  const onClose = vi.fn();
  const onTab = vi.fn();
  render(
    <DetailShell
      title="coredns-abc"
      subtitle="kube-system"
      tabs={TABS}
      tab={tab}
      onTab={onTab}
      onClose={onClose}
      backTo="pods"
    >
      <textarea aria-label="Object YAML" defaultValue="kind: Pod" />
    </DetailShell>,
  );
  return { onClose, onTab, user: userEvent.setup() };
}

describe("DetailShell", () => {
  it("marks the active tab and reports the one clicked", async () => {
    const { onTab, user } = setup();
    expect(screen.getByRole("button", { name: "Overview" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await user.click(screen.getByRole("button", { name: "YAML" }));
    expect(onTab).toHaveBeenCalledWith("yaml");
  });

  it("closes on Escape", async () => {
    const { onClose, user } = setup();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not close on Escape while the user is typing", async () => {
    // Escape inside the YAML editor must not close the page out from
    // under an edit in progress — that would discard the draft.
    const { onClose, user } = setup();
    await user.click(screen.getByRole("textbox", { name: "Object YAML" }));
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("names what the back button returns to", () => {
    setup();
    expect(screen.getByRole("button", { name: "Back to pods" })).toBeInTheDocument();
  });

  it("shows an error without hiding the content underneath", () => {
    render(
      <DetailShell
        title="node-1"
        tabs={TABS}
        tab="overview"
        onTab={vi.fn()}
        onClose={vi.fn()}
        error={{ kind: "kubernetes", message: "nodes is forbidden" }}
      >
        <p>still here</p>
      </DetailShell>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("nodes is forbidden");
    expect(screen.getByText("still here")).toBeInTheDocument();
  });
});
