import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditableYaml } from "./EditableYaml";
import { api } from "../lib/api";
import type { EditTarget } from "../lib/api";

// The write path's whole surface. What is asserted here is what makes
// the editor safe to use on a real cluster: an edit in flight is never
// lost, a failure explains itself without discarding the text, and a
// kind the cluster will not accept updates to offers no editor at all.

vi.mock("../lib/api", async (original) => {
  const actual = await original<typeof import("../lib/api")>();
  return {
    ...actual,
    api: { ...actual.api, applyYaml: vi.fn() },
  };
});

const applyYaml = vi.mocked(api.applyYaml);

const SOURCE = "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: settings\n";

const TARGET: EditTarget = {
  apiVersion: "v1",
  kind: "ConfigMap",
  namespace: "default",
  name: "settings",
};

function setup(props: Partial<Parameters<typeof EditableYaml>[0]> = {}) {
  const onApplied = vi.fn();
  render(
    <EditableYaml
      source={SOURCE}
      target={TARGET}
      onApplied={onApplied}
      {...props}
    />,
  );
  return { onApplied, user: userEvent.setup() };
}

async function enterEditMode(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Edit" }));
  return screen.getByRole("textbox", { name: "Object YAML" });
}

beforeEach(() => {
  applyYaml.mockReset();
});

describe("EditableYaml", () => {
  it("starts read-only and opens an editor holding the current YAML", async () => {
    const { user } = setup();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    const editor = await enterEditMode(user);
    expect(editor).toHaveValue(SOURCE);
  });

  it("offers no editor for a kind the cluster will not accept updates to", () => {
    // An Edit button that always fails is worse than none: it invites
    // the user to retype an edit that was never going to land.
    setup({ target: null });
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
  });

  it("will not apply an unchanged document", async () => {
    const { user } = setup();
    await enterEditMode(user);
    // Nothing to write: it could only burn a resourceVersion.
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  it("sends the edited text with the target it was opened on", async () => {
    applyYaml.mockResolvedValue({ yaml: "applied: true\n", resourceVersion: "2" });
    const { user, onApplied } = setup();

    const editor = await enterEditMode(user);
    await user.clear(editor);
    await user.type(editor, "edited: yes");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(applyYaml).toHaveBeenCalledOnce());
    expect(applyYaml).toHaveBeenCalledWith(TARGET, "edited: yes");
    expect(onApplied).toHaveBeenCalledWith("applied: true\n");
  });

  it("leaves edit mode only once the apply succeeds", async () => {
    applyYaml.mockResolvedValue({ yaml: SOURCE, resourceVersion: "2" });
    const { user } = setup();

    const editor = await enterEditMode(user);
    await user.type(editor, "extra: 1");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() =>
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument(),
    );
  });

  it("keeps the draft and shows why when the apply is refused", async () => {
    // The critical case. Dropping the text here would mean retyping an
    // edit blind, which is how an editor loses a user's trust for good.
    applyYaml.mockRejectedValue({
      kind: "invalid_edit",
      message: "cannot change the name here",
    });
    const { user, onApplied } = setup();

    const editor = await enterEditMode(user);
    await user.type(editor, "extra: 1");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "cannot change the name here",
    );
    expect(screen.getByRole("textbox", { name: "Object YAML" })).toHaveValue(
      SOURCE + "extra: 1",
    );
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("offers to reload after a conflict, and nothing else does", async () => {
    applyYaml.mockRejectedValue({
      kind: "conflict",
      message: "settings was changed in the cluster",
    });
    const { user } = setup();

    const editor = await enterEditMode(user);
    await user.type(editor, "extra: 1");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    // A stale write is the one failure with an obvious next step.
    const discard = await screen.findByRole("button", {
      name: /discard.*reload/i,
    });
    await user.click(discard);
    await waitFor(() =>
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument(),
    );
  });

  it("does not offer to reload for an ordinary failure", async () => {
    applyYaml.mockRejectedValue({ kind: "kubernetes", message: "forbidden" });
    const { user } = setup();

    const editor = await enterEditMode(user);
    await user.type(editor, "extra: 1");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await screen.findByRole("alert");
    expect(
      screen.queryByRole("button", { name: /discard.*reload/i }),
    ).not.toBeInTheDocument();
  });

  it("discards the draft on cancel without touching the cluster", async () => {
    const { user, onApplied } = setup();

    const editor = await enterEditMode(user);
    await user.type(editor, "extra: 1");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(applyYaml).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();

    // Reopening starts from the server's copy, not the abandoned draft.
    expect(await enterEditMode(user)).toHaveValue(SOURCE);
  });

  it("indents with Tab rather than leaving the editor", async () => {
    // YAML is indentation; a Tab key that escapes the field makes the
    // editor unusable for the thing it exists to edit.
    const { user } = setup();
    const editor = await enterEditMode(user);

    await user.clear(editor);
    await user.type(editor, "a:");
    await user.tab();

    expect(editor).toHaveFocus();
    expect(editor).toHaveValue("a:  ");
  });
});
