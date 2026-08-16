import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "./CommandPalette";
import type { Command } from "../lib/palette";

// The palette exists so a session can run without the mouse, so most of
// what matters here is keyboard behaviour: that the selection tracks the
// visible order, that Enter runs what is highlighted, and that a new
// result set cannot leave Enter pointing at something the user never
// looked at.

function command(label: string, over: Partial<Command> = {}): Command {
  return { id: label, group: "Go to", label, run: vi.fn(), ...over };
}

function setup(commands: Command[]) {
  const onClose = vi.fn();
  render(<CommandPalette commands={commands} onClose={onClose} />);
  return { onClose, user: userEvent.setup() };
}

const DEFAULTS = [
  command("Pods"),
  command("Deployments"),
  command("Services"),
  command("Disconnect", { group: "Action" }),
];

describe("CommandPalette", () => {
  it("lists everything until something is typed", () => {
    setup(DEFAULTS);
    expect(screen.getByRole("button", { name: /Pods/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Disconnect/ })).toBeInTheDocument();
  });

  it("groups commands under fixed headings", () => {
    setup(DEFAULTS);
    expect(screen.getByText("Go to")).toBeInTheDocument();
    expect(screen.getByText("Action")).toBeInTheDocument();
  });

  it("narrows as you type", async () => {
    const { user } = setup(DEFAULTS);
    await user.type(screen.getByLabelText("Command"), "deploy");

    expect(screen.getByRole("button", { name: /Deployments/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Disconnect/ })).not.toBeInTheDocument();
  });

  it("runs the highlighted command on Enter", async () => {
    const run = vi.fn();
    const { user, onClose } = setup([command("Pods", { run })]);

    await user.keyboard("{Enter}");

    expect(run).toHaveBeenCalled();
    // Closed first: running a command usually changes the view under it.
    expect(onClose).toHaveBeenCalled();
  });

  it("moves the selection with the arrow keys", async () => {
    const second = vi.fn();
    const { user } = setup([command("First"), command("Second", { run: second })]);

    await user.keyboard("{ArrowDown}{Enter}");
    expect(second).toHaveBeenCalled();
  });

  it("does not move past the ends of the list", async () => {
    const first = vi.fn();
    const { user } = setup([command("First", { run: first }), command("Second")]);

    // Up from the top stays at the top rather than wrapping into
    // whatever is last, which would run something unexpected.
    await user.keyboard("{ArrowUp}{ArrowUp}{Enter}");
    expect(first).toHaveBeenCalled();
  });

  it("walks the order shown, not the order ranked", async () => {
    // Grouping reorders the list. If the arrows followed the ranked
    // order instead, the highlight and the keyboard would disagree.
    const disconnect = vi.fn();
    const { user } = setup([
      command("Disconnect", { group: "Action", run: disconnect }),
      command("Pods", { group: "Go to" }),
    ]);

    // "Go to" is rendered first, so Pods is index 0 and Disconnect is 1.
    await user.keyboard("{ArrowDown}{Enter}");
    expect(disconnect).toHaveBeenCalled();
  });

  it("resets the selection when the results change", async () => {
    // Otherwise Enter runs whatever now sits at the old index — a
    // command the user never looked at.
    const pods = vi.fn();
    const { user } = setup([
      command("Deployments"),
      command("Pods", { run: pods }),
    ]);

    await user.keyboard("{ArrowDown}");
    await user.type(screen.getByLabelText("Command"), "pods");
    await user.keyboard("{Enter}");

    expect(pods).toHaveBeenCalled();
  });

  it("closes on Escape without running anything", async () => {
    const run = vi.fn();
    const { user, onClose } = setup([command("Pods", { run })]);

    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("runs a command that is clicked", async () => {
    const run = vi.fn();
    const { user } = setup([command("Pods", { run })]);

    await user.click(screen.getByRole("button", { name: /Pods/ }));
    expect(run).toHaveBeenCalled();
  });

  it("says so when nothing matches", async () => {
    const { user } = setup(DEFAULTS);
    await user.type(screen.getByLabelText("Command"), "nothing here");
    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument();
  });

  it("does not run anything on Enter with no results", async () => {
    const run = vi.fn();
    const { user, onClose } = setup([command("Pods", { run })]);

    await user.type(screen.getByLabelText("Command"), "zzzz");
    await user.keyboard("{Enter}");

    expect(run).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows the hint beside the label", async () => {
    setup([command("Agents", { hint: "krypton.ai" })]);
    expect(screen.getByText("krypton.ai")).toBeInTheDocument();
  });
});
