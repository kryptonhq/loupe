import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ObjectActions } from "./ObjectActions";
import { ClusterContext } from "../lib/clusterContext";
import { api, type Guard } from "../lib/api";

// The verbs. What is asserted here is mostly about what is *not*
// offered: an action the user's RBAC forbids, an action that makes no
// sense for the kind, and every action at all on a read-only context.
// Offering a button that is guaranteed to be refused is a choice, and
// the wrong one.

vi.mock("../lib/api", async (original) => {
  const actual = await original<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      scaleObject: vi.fn(),
      rolloutRestart: vi.fn(),
      deleteObject: vi.fn(),
    },
  };
});

const scaleObject = vi.mocked(api.scaleObject);
const rolloutRestart = vi.mocked(api.rolloutRestart);
const deleteObject = vi.mocked(api.deleteObject);

const DEPLOYMENT = { group: "apps", version: "v1", kind: "Deployment" };

function setup({
  resource = DEPLOYMENT,
  verbs = ["get", "list", "patch", "update", "delete"],
  guard = "open" as Guard,
  context = "kind-local",
} = {}) {
  const onDone = vi.fn();
  render(
    <ClusterContext.Provider value={{ context, guard }}>
      <ObjectActions
        resource={resource}
        namespace="payments"
        name="api"
        verbs={verbs}
        onDone={onDone}
      />
    </ClusterContext.Provider>,
  );
  return { onDone, user: userEvent.setup() };
}

beforeEach(() => {
  scaleObject.mockReset();
  rolloutRestart.mockReset();
  deleteObject.mockReset();
  scaleObject.mockResolvedValue(3);
  rolloutRestart.mockResolvedValue("2026-08-16T10:00:00Z");
  deleteObject.mockResolvedValue(undefined);
});

describe("ObjectActions", () => {
  it("offers the verbs that apply to the kind", () => {
    setup();
    expect(screen.getByRole("button", { name: "Scale…" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete…" })).toBeInTheDocument();
  });

  it("does not offer scale for a kind that cannot scale", () => {
    // A Scale button on a ConfigMap produces a 404 the user cannot act on.
    setup({ resource: { group: "", version: "v1", kind: "ConfigMap" } });
    expect(screen.queryByRole("button", { name: "Scale…" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete…" })).toBeInTheDocument();
  });

  it("does not offer restart for a kind with no pod template", () => {
    setup({ resource: { group: "", version: "v1", kind: "Service" } });
    expect(screen.queryByRole("button", { name: "Restart" })).not.toBeInTheDocument();
  });

  it("hides an action the API server will not accept", () => {
    // Discovery already tells us the verbs. Offering delete to someone
    // who cannot delete is a button that only ever produces a denial.
    setup({ verbs: ["get", "list"] });
    expect(screen.queryByRole("button", { name: "Delete…" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restart" })).not.toBeInTheDocument();
  });

  it("offers everything when discovery has not answered yet", () => {
    // Hiding actions because discovery was slow would be worse than
    // letting the server refuse one.
    setup({ verbs: [] });
    expect(screen.getByRole("button", { name: "Delete…" })).toBeInTheDocument();
  });

  it("offers nothing at all on a read-only context", () => {
    setup({ guard: "readOnly" });
    expect(screen.queryByRole("button", { name: "Delete…" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Scale…" })).not.toBeInTheDocument();
  });

  it("confirms before deleting, and names the cluster", async () => {
    // The cluster matters more than the object: deleting the
    // right-looking pod on the wrong cluster is the failure being
    // guarded against.
    const { user } = setup({ context: "eks-prod-eu" });
    await user.click(screen.getByRole("button", { name: "Delete…" }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("eks-prod-eu")).toBeInTheDocument();
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it("deletes once confirmed", async () => {
    const { user, onDone } = setup();
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(deleteObject).toHaveBeenCalledWith(DEPLOYMENT, "payments", "api"),
    );
    expect(onDone).toHaveBeenCalled();
  });

  it("sends the replica count that was typed", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Scale…" }));

    const field = await screen.findByLabelText("Replicas");
    await user.clear(field);
    await user.type(field, "5");
    await user.click(screen.getByRole("button", { name: "Scale" }));

    await waitFor(() =>
      expect(scaleObject).toHaveBeenCalledWith(DEPLOYMENT, "payments", "api", 5),
    );
  });

  it("restarts once confirmed", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Restart" }));

    // Scoped to the dialog: the toolbar button that opened it has the
    // same name, which is the right wording for both.
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Restart" }));

    await waitFor(() =>
      expect(rolloutRestart).toHaveBeenCalledWith(DEPLOYMENT, "payments", "api"),
    );
  });

  it("does nothing when the confirmation is cancelled", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(deleteObject).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("requires the context name on a protected context", async () => {
    const { user } = setup({ guard: "protected", context: "eks-prod-eu" });
    await user.click(screen.getByRole("button", { name: "Delete…" }));

    const confirm = await screen.findByRole("button", { name: "Delete" });
    expect(confirm).toBeDisabled();

    await user.type(
      screen.getByLabelText("Type the context name to confirm"),
      "eks-prod-eu",
    );
    expect(confirm).toBeEnabled();
  });

  it("keeps the dialog open and shows why when the server refuses", async () => {
    // The API server's wording is the whole answer, especially for an
    // RBAC denial. Closing the dialog would throw it away.
    deleteObject.mockRejectedValue({
      kind: "kubernetes",
      message: 'deployments is forbidden: User "dev" cannot delete',
    });

    const { user, onDone } = setup();
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("forbidden");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("surfaces a local refusal from the read-only guard", async () => {
    // The UI check and the backend check should agree, but if they ever
    // do not, the user must see why rather than watch nothing happen.
    deleteObject.mockRejectedValue({
      kind: "read_only",
      message: "eks-prod-eu is marked read-only in Loupe. Nothing was sent.",
    });

    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Delete…" }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Nothing was sent");
  });
});
