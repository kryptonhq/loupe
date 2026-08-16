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

/// Applying is now two steps: review the diff, then confirm. Almost
/// every test here is about what happens after the request is sent, so
/// they go through both rather than asserting on the panel each time.
async function applyThrough(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /Review & apply/ }));
  await user.click(await screen.findByRole("button", { name: "Apply" }));
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
    expect(
      screen.getByRole("button", { name: /Review & apply/ }),
    ).toBeDisabled();
  });

  it("sends the edited text with the target it was opened on", async () => {
    applyYaml.mockResolvedValue({ yaml: "applied: true\n", resourceVersion: "2" });
    const { user, onApplied } = setup();

    const editor = await enterEditMode(user);
    await user.clear(editor);
    await user.type(editor, "edited: yes");
    await applyThrough(user);

    await waitFor(() => expect(applyYaml).toHaveBeenCalledOnce());
    expect(applyYaml).toHaveBeenCalledWith(TARGET, "edited: yes");
    expect(onApplied).toHaveBeenCalledWith("applied: true\n");
  });

  it("leaves edit mode only once the apply succeeds", async () => {
    applyYaml.mockResolvedValue({ yaml: SOURCE, resourceVersion: "2" });
    const { user } = setup();

    const editor = await enterEditMode(user);
    await user.type(editor, "extra: 1");
    await applyThrough(user);

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
    await applyThrough(user);

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
    await applyThrough(user);

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
    await applyThrough(user);

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

  // The review step. Applying without looking is how outages start, and
  // a full replace was previously sent on the strength of a button
  // press.

  it("shows what will change before sending anything", async () => {
    const { user } = setup();
    const editor = await enterEditMode(user);
    await user.type(editor, "extra: 1");

    await user.click(screen.getByRole("button", { name: /Review & apply/ }));

    expect(await screen.findByText(/extra: 1/)).toBeInTheDocument();
    expect(applyYaml).not.toHaveBeenCalled();
  });

  it("names the cluster in the confirmation, not just the object", async () => {
    // Which cluster matters more than which object, and the sidebar is
    // not where someone looks at the moment they press apply.
    const { user } = setup({ context: "eks-prod-eu" });
    const editor = await enterEditMode(user);
    await user.type(editor, "extra: 1");
    await user.click(screen.getByRole("button", { name: /Review & apply/ }));

    expect(await screen.findByText("eks-prod-eu")).toBeInTheDocument();
  });

  it("goes back to the editor with the text intact", async () => {
    const { user } = setup();
    const editor = await enterEditMode(user);
    await user.type(editor, "extra: 1");
    await user.click(screen.getByRole("button", { name: /Review & apply/ }));

    await user.click(await screen.findByRole("button", { name: "Back" }));

    expect(screen.getByRole("textbox", { name: "Object YAML" })).toHaveValue(
      SOURCE + "extra: 1",
    );
    expect(applyYaml).not.toHaveBeenCalled();
  });

  it("will not send an edit that only touches server-managed fields", async () => {
    // Otherwise the user is asked to confirm a write that changes
    // nothing, which teaches them to click through the confirmation.
    const source = "metadata:\n  name: x\n  resourceVersion: \"1\"\n";
    const { user } = setup({ source });

    const editor = await enterEditMode(user);
    await user.clear(editor);
    await user.type(editor, 'metadata:\n  name: x\n  resourceVersion: "999"');
    await user.click(screen.getByRole("button", { name: /Review & apply/ }));

    expect(await screen.findByText(/Nothing would change/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });

  // Protection. RBAC is not this: plenty of people hold write permission
  // on production and still do not want a stray click to use it.

  it("offers no editor at all on a read-only context", async () => {
    setup({ guard: "readOnly", context: "eks-prod-eu" });

    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    // Said out loud, so the absence is legible rather than looking broken.
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });

  it("requires the context name to be typed on a protected context", async () => {
    const { user } = setup({ guard: "protected", context: "eks-prod-eu" });
    const editor = await enterEditMode(user);
    await user.type(editor, "extra: 1");
    await user.click(screen.getByRole("button", { name: /Review & apply/ }));

    const apply = await screen.findByRole("button", { name: "Apply" });
    expect(apply).toBeDisabled();

    await user.type(
      screen.getByLabelText("Type the context name to confirm"),
      "eks-prod-eu",
    );
    expect(apply).toBeEnabled();
  });

  it("does not accept the wrong context name", async () => {
    const { user } = setup({ guard: "protected", context: "eks-prod-eu" });
    const editor = await enterEditMode(user);
    await user.type(editor, "extra: 1");
    await user.click(screen.getByRole("button", { name: /Review & apply/ }));

    await user.type(
      await screen.findByLabelText("Type the context name to confirm"),
      "eks-prod-us",
    );

    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(applyYaml).not.toHaveBeenCalled();
  });

  it("asks for nothing extra on an unprotected context", async () => {
    // The default has to stay exactly what it was for everyone who has
    // not asked for this.
    const { user } = setup({ guard: "open", context: "kind-local" });
    const editor = await enterEditMode(user);
    await user.type(editor, "extra: 1");
    await user.click(screen.getByRole("button", { name: /Review & apply/ }));

    expect(
      screen.queryByLabelText("Type the context name to confirm"),
    ).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Apply" })).toBeEnabled();
  });

  it("surfaces a refusal from the backend even if the UI allowed it", async () => {
    // The UI check is a courtesy; the backend check is the guarantee.
    // If they ever disagree, the user must see why.
    applyYaml.mockRejectedValue({
      kind: "read_only",
      message: "eks-prod-eu is marked read-only in Loupe. Nothing was sent.",
    });
    const { user } = setup({ context: "eks-prod-eu" });

    const editor = await enterEditMode(user);
    await user.type(editor, "extra: 1");
    await applyThrough(user);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Nothing was sent",
    );
  });
});
