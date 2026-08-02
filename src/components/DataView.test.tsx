import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DataView } from "./DataView";
import { api, type DataKey, type ResourceData } from "../lib/api";

// The Data tab is where a Secret is most likely to be leaked by
// accident, so most of what is asserted here is about what does *not*
// appear on screen. The Rust side withholds the values; these tests
// cover the half of the contract the frontend is responsible for —
// never asking for a value the user did not ask for, and never leaving
// one on screen after they hid it.

vi.mock("../lib/api", async (original) => {
  const actual = await original<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getSecretData: vi.fn(),
      getConfigMapData: vi.fn(),
    },
  };
});

const getSecretData = vi.mocked(api.getSecretData);
const getConfigMapData = vi.mocked(api.getConfigMapData);

function key(
  name: string,
  bytes: number,
  value: string | null = null,
  binary = false,
): DataKey {
  return { key: name, bytes, value, binary };
}

/// Stands in for the Rust side: returns values only for the keys named
/// in `reveal`, which is exactly what `secret_data` does.
function secretBacking(values: Record<string, string>) {
  return async (
    _namespace: string,
    _name: string,
    reveal: string[] = [],
  ): Promise<ResourceData> => ({
    type: "Opaque",
    redacted: true,
    keys: Object.entries(values).map(([k, v]) =>
      key(k, v.length, reveal.includes(k) ? v : null),
    ),
  });
}

function renderData(kind: "config" | "secret") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <DataView namespace="prod" name="db-credentials" kind={kind} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  getSecretData.mockReset();
  getConfigMapData.mockReset();

  getSecretData.mockImplementation(
    secretBacking({ username: "postgres", password: "hunter2" }),
  );
  getConfigMapData.mockResolvedValue({
    type: null,
    redacted: false,
    keys: [key("log_level", 5, "debug"), key("timeout", 3, "30s")],
  });
});

describe("DataView, on a Secret", () => {
  it("lists the keys without asking for any value", async () => {
    renderData("secret");
    expect(await screen.findByText("password")).toBeInTheDocument();
    expect(screen.getByText("username")).toBeInTheDocument();

    // The opening request must name no keys. Anything else would fetch
    // credentials the user never asked to see.
    expect(getSecretData).toHaveBeenCalledWith("prod", "db-credentials", []);
    expect(screen.queryByText("hunter2")).not.toBeInTheDocument();
    expect(screen.queryByText("postgres")).not.toBeInTheDocument();
  });

  it("says how big a key is without saying what it holds", async () => {
    // The point of the withheld view: the shape of the Secret answers
    // most questions, and reading it stays a deliberate act.
    renderData("secret");
    expect(await screen.findByText("7 B")).toBeInTheDocument();
    expect(screen.queryByText("hunter2")).not.toBeInTheDocument();
  });

  it("reveals only the key that was asked for", async () => {
    const user = renderData("secret");
    await screen.findByText("password");

    const rows = screen.getAllByRole("listitem");
    const passwordRow = rows.find((r) => r.textContent?.includes("password"))!;
    await user.click(within(passwordRow).getByRole("button", { name: "Reveal" }));

    expect(await screen.findByText("hunter2")).toBeInTheDocument();
    // The other credential in the same object stays hidden. This is why
    // `reveal` is a list of names rather than a boolean.
    expect(screen.queryByText("postgres")).not.toBeInTheDocument();
    expect(getSecretData).toHaveBeenLastCalledWith("prod", "db-credentials", [
      "password",
    ]);
  });

  it("takes a revealed value back off the screen when hidden", async () => {
    const user = renderData("secret");
    await screen.findByText("password");

    const passwordRow = screen
      .getAllByRole("listitem")
      .find((r) => r.textContent?.includes("password"))!;
    await user.click(within(passwordRow).getByRole("button", { name: "Reveal" }));
    await screen.findByText("hunter2");

    await user.click(
      within(
        screen
          .getAllByRole("listitem")
          .find((r) => r.textContent?.includes("password"))!,
      ).getByRole("button", { name: "Hide" }),
    );

    await waitFor(() =>
      expect(screen.queryByText("hunter2")).not.toBeInTheDocument(),
    );
    // And the next request stops asking for it, so a re-fetch does not
    // quietly bring it back.
    expect(getSecretData).toHaveBeenLastCalledWith("prod", "db-credentials", []);
  });

  it("offers no reveal for a binary value", async () => {
    // A DER-encoded key has nothing legible to show, and a Reveal button
    // that produces replacement characters reads as a broken app.
    getSecretData.mockResolvedValue({
      type: "kubernetes.io/tls",
      redacted: true,
      keys: [key("tls.key", 1704, null, true)],
    });

    renderData("secret");
    expect(await screen.findByText("binary")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reveal" }),
    ).not.toBeInTheDocument();
  });

  it("says that values are held back", async () => {
    // Without this the tab looks like a Secret with no data in it.
    renderData("secret");
    expect(await screen.findByText(/held back/)).toBeInTheDocument();
  });

  it("shows the Secret's type", async () => {
    renderData("secret");
    expect(await screen.findByText("Opaque")).toBeInTheDocument();
  });
});

describe("DataView, on a ConfigMap", () => {
  it("shows every value outright", async () => {
    // A ConfigMap holds nothing to hide, and making people click Reveal
    // per key would be friction with no security behind it.
    renderData("config");
    expect(await screen.findByText("debug")).toBeInTheDocument();
    expect(screen.getByText("30s")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reveal" }),
    ).not.toBeInTheDocument();
  });

  it("does not claim anything is held back", async () => {
    renderData("config");
    await screen.findByText("debug");
    expect(screen.queryByText(/held back/)).not.toBeInTheDocument();
  });

  it("reads a ConfigMap without going near the Secret endpoint", async () => {
    renderData("config");
    await screen.findByText("debug");
    expect(getConfigMapData).toHaveBeenCalledWith("prod", "db-credentials");
    expect(getSecretData).not.toHaveBeenCalled();
  });
});

describe("DataView, when there is nothing to show", () => {
  it("says so rather than rendering an empty list", async () => {
    getConfigMapData.mockResolvedValue({
      type: null,
      redacted: false,
      keys: [],
    });
    renderData("config");
    expect(await screen.findByText("No data.")).toBeInTheDocument();
  });

  it("surfaces a failure instead of looking empty", async () => {
    // An RBAC denial on Secrets is common and specific; showing "No
    // data" for it would send the user looking for the wrong problem.
    getSecretData.mockRejectedValue({
      kind: "kubernetes",
      message: 'secrets is forbidden: User "dev" cannot get resource "secrets"',
    });
    renderData("secret");
    expect(await screen.findByText(/forbidden/)).toBeInTheDocument();
  });
});
