import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ObjectDetail } from "./ObjectDetail";
import { api, type GvkRef, type ObjectDetail as ObjectDetailData } from "../lib/api";

// Detail for a kind nothing knew about at compile time. Two things here
// are worth more than the rest: a Secret must reach the Data tab rather
// than the YAML, and a read-only object must not be offered an editor.

vi.mock("../lib/api", async (original) => {
  const actual = await original<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getObject: vi.fn(),
      getSecretData: vi.fn(),
      getConfigMapData: vi.fn(),
      listEvents: vi.fn(),
    },
  };
});

const getObject = vi.mocked(api.getObject);
const getSecretData = vi.mocked(api.getSecretData);
const listEvents = vi.mocked(api.listEvents);

const AGENT: GvkRef = {
  group: "krypton.ai",
  version: "v1alpha1",
  kind: "Agent",
};
const SECRET: GvkRef = { group: "", version: "v1", kind: "Secret" };

function object(overrides: Partial<ObjectDetailData> = {}): ObjectDetailData {
  return {
    apiVersion: "krypton.ai/v1alpha1",
    kind: "Agent",
    name: "mcp-hello",
    namespace: "agents",
    age: "65d",
    status: "Ready",
    labels: [],
    annotations: [],
    conditions: [],
    editable: true,
    yaml: "apiVersion: krypton.ai/v1alpha1\nkind: Agent\n",
    ...overrides,
  };
}

function renderDetail(
  resource: GvkRef = AGENT,
  namespace: string | null = "agents",
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ObjectDetail
        resource={resource}
        namespace={namespace}
        name={resource.kind === "Secret" ? "db-credentials" : "mcp-hello"}
        onClose={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  getObject.mockReset().mockResolvedValue(object());
  getSecretData.mockReset().mockResolvedValue({
    type: "Opaque",
    redacted: true,
    keys: [{ key: "password", bytes: 7, value: null, binary: false }],
  });
  vi.mocked(api.getConfigMapData).mockReset();
  listEvents.mockReset().mockResolvedValue([]);
});

describe("ObjectDetail", () => {
  it("shows what the API conventions promise and nothing invented", async () => {
    renderDetail();
    expect(await screen.findByText("Agent")).toBeInTheDocument();
    expect(screen.getByText("krypton.ai/v1alpha1")).toBeInTheDocument();
    expect(screen.getByText("agents")).toBeInTheDocument();
  });

  it("shows a condition's reason and message", async () => {
    getObject.mockResolvedValue(
      object({
        status: "NotReady: ModelPullFailed",
        conditions: [
          {
            type: "Ready",
            status: "False",
            reason: "ModelPullFailed",
            message: "could not pull qwen2:0.5b",
          },
        ],
      }),
    );

    renderDetail();
    expect(await screen.findByText("Ready: False")).toBeInTheDocument();
    expect(screen.getByText("ModelPullFailed")).toBeInTheDocument();
    expect(screen.getByText(/could not pull/)).toBeInTheDocument();
  });

  it("gives a Secret its own Data tab", async () => {
    // A Secret is opened to read its contents. Sending people to the
    // YAML — where the values are redacted — would be a dead end.
    getObject.mockResolvedValue(
      object({
        apiVersion: "v1",
        kind: "Secret",
        name: "db-credentials",
        namespace: "prod",
        editable: false,
        status: null,
      }),
    );

    const user = renderDetail(SECRET, "prod");
    await screen.findByText("Secret");
    await user.click(screen.getByRole("button", { name: "Data" }));

    expect(await screen.findByText("password")).toBeInTheDocument();
    expect(getSecretData).toHaveBeenCalledWith("prod", "db-credentials", []);
  });

  it("explains why a Secret's YAML cannot be applied", async () => {
    // "Read-only" alone would look like an RBAC problem. The real reason
    // is that saving redacted text would overwrite every value.
    getObject.mockResolvedValue(
      object({
        apiVersion: "v1",
        kind: "Secret",
        name: "db-credentials",
        namespace: "prod",
        editable: false,
        status: null,
      }),
    );

    renderDetail(SECRET, "prod");
    expect(
      await screen.findByText(/overwrite every value with the placeholder/),
    ).toBeInTheDocument();
  });

  it("names the kind when the cluster will not accept updates", async () => {
    getObject.mockResolvedValue(object({ editable: false }));
    renderDetail();
    expect(
      await screen.findByText(/does not accept updates to Agent/),
    ).toBeInTheDocument();
  });

  it("gives no Data tab to a kind that holds no key/value map", async () => {
    renderDetail();
    await screen.findByText("Agent");
    expect(screen.queryByRole("button", { name: "Data" })).not.toBeInTheDocument();
  });

  it("gives no Events tab to a cluster-scoped object", async () => {
    // There is no namespace to look for events in, and guessing
    // "default" would show somebody else's.
    getObject.mockResolvedValue(
      object({ namespace: null, kind: "ClusterAgent" }),
    );
    renderDetail({ ...AGENT, kind: "ClusterAgent" }, null);

    await screen.findByText("ClusterAgent");
    expect(
      screen.queryByRole("button", { name: "Events" }),
    ).not.toBeInTheDocument();
  });

  it("filters events to this object", async () => {
    const user = renderDetail();
    await screen.findByText("Agent");
    await user.click(screen.getByRole("button", { name: "Events" }));

    expect(listEvents).toHaveBeenCalledWith("agents", "mcp-hello");
  });

  it("surfaces a failure to read the object", async () => {
    getObject.mockRejectedValue({
      kind: "unknown_resource",
      message: "Agent (krypton.ai/v1alpha1) is not served by this cluster",
    });
    renderDetail();
    expect(await screen.findByText(/not served by this cluster/)).toBeInTheDocument();
  });
});
