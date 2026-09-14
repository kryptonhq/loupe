import { describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette, type ObjectSearch } from "./CommandPalette";
import type { Command } from "../lib/palette";
import type { SearchHit, SearchResponse } from "../lib/api";

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

describe("CommandPalette object search", () => {
  const hit = (name: string, kind = "Pod", over: Partial<SearchHit> = {}): SearchHit => ({
    group: "",
    version: "v1",
    kind,
    namespace: "shop",
    name,
    status: null,
    ...over,
  });
  const response = (hits: SearchHit[], over: Partial<SearchResponse> = {}): SearchResponse => ({
    hits,
    indexedKinds: 40,
    totalKinds: 43,
    forbiddenKinds: 3,
    failedKinds: 0,
    objects: 5_120,
    warming: false,
    approxBytes: 1,
    ...over,
  });

  function withObjects(search: ObjectSearch["search"], commands: Command[] = DEFAULTS) {
    const open = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette commands={commands} onClose={onClose} objects={{ search, open }} />);
    return { open, onClose, user: userEvent.setup() };
  }

  it("starts the index warming as soon as it opens", async () => {
    const search = vi.fn().mockResolvedValue(response([]));
    withObjects(search);
    await waitFor(() => expect(search).toHaveBeenCalledWith(""));
  });

  it("lists matching objects grouped by kind, after the commands", async () => {
    const search = vi.fn().mockImplementation(async (q: string) =>
      q === "api" ? response([hit("api-7d9", "Pod", { status: "Running" }), hit("api", "Service")]) : response([]),
    );
    const { user } = withObjects(search, [command("Api docs", { group: "Action" })]);
    await user.type(screen.getByLabelText("Command"), "api");

    expect(await screen.findByText("api-7d9")).toBeInTheDocument();
    expect(screen.getByText("shop · Running")).toBeInTheDocument();
    const headings = screen.getAllByText(/^(Action|Pod|Service)$/).map((h) => h.textContent);
    expect(headings).toEqual(["Action", "Pod", "Service"]);
  });

  it("says how much of the cluster it covered, including what it was not allowed to see", async () => {
    const search = vi.fn().mockResolvedValue(response([hit("api-7d9")]));
    const { user } = withObjects(search);
    await user.type(screen.getByLabelText("Command"), "api");
    expect(await screen.findByText("5,120 objects in 40 of 43 kinds · 3 kinds not permitted")).toBeInTheDocument();
  });

  it("opens an object here on Enter and in a new tab on ⌘-Enter", async () => {
    const search = vi.fn().mockResolvedValue(response([hit("api-7d9")]));
    const { open, onClose, user } = withObjects(search, []);
    await user.type(screen.getByLabelText("Command"), "api");
    await screen.findByText("api-7d9");

    await user.keyboard("{Enter}");
    expect(onClose).toHaveBeenCalled();
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ name: "api-7d9" }), "here");

    cleanup();
    const second = withObjects(search, []);
    await second.user.type(screen.getByLabelText("Command"), "api");
    await screen.findByText("api-7d9");
    await second.user.keyboard("{Meta>}{Enter}{/Meta}");
    expect(second.open).toHaveBeenLastCalledWith(expect.objectContaining({ name: "api-7d9" }), "newTab");
  });

  it("does not search the cluster for a single character", async () => {
    const search = vi.fn().mockResolvedValue(response([]));
    const { user } = withObjects(search);
    await user.type(screen.getByLabelText("Command"), "a");
    await new Promise((r) => setTimeout(r, 150));
    expect(search).toHaveBeenCalledTimes(1); // only the warm-up
  });

  it("ignores a slow answer to a query that has since changed", async () => {
    let slow: (r: SearchResponse) => void = () => {};
    const search = vi.fn().mockImplementation((q: string) =>
      q === "ap"
        ? new Promise<SearchResponse>((r) => (slow = r))
        : Promise.resolve(response(q === "api" ? [hit("api-new")] : [])),
    );
    const { user } = withObjects(search, []);
    const input = screen.getByLabelText("Command");
    await user.type(input, "ap");
    await waitFor(() => expect(search).toHaveBeenCalledWith("ap"));
    await user.type(input, "i");
    await screen.findByText("api-new");

    await act(async () => slow(response([hit("stale-result")])));
    expect(screen.queryByText("stale-result")).not.toBeInTheDocument();
    expect(screen.getByText("api-new")).toBeInTheDocument();
  });

  it("says it is still indexing rather than that nothing matches, and asks again", async () => {
    let calls = 0;
    const search = vi.fn().mockImplementation(async (q: string) => {
      if (q === "") return response([], { warming: true });
      calls += 1;
      return calls === 1 ? response([], { warming: true, indexedKinds: 2 }) : response([hit("late-pod")]);
    });
    const { user } = withObjects(search, []);
    await user.type(screen.getByLabelText("Command"), "late");
    expect(await screen.findByText(/still indexing the cluster/)).toBeInTheDocument();
    expect(await screen.findByText("late-pod", {}, { timeout: 2000 })).toBeInTheDocument();
  });

  it("shows a search failure in the footer without losing the commands", async () => {
    const search = vi.fn().mockImplementation(async (q: string) => {
      if (q === "") return response([]);
      throw { kind: "not_connected", message: "not connected to a cluster" };
    });
    const { user } = withObjects(search);
    await user.type(screen.getByLabelText("Command"), "pods");
    expect(await screen.findByText("not connected to a cluster")).toBeInTheDocument();
    expect(screen.getByText("Pods")).toBeInTheDocument();
  });
});
