import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ResourceTable } from "./ResourceTable";
import { Table, type Column } from "./Table";

// Every resource view in the app renders through these two. What is
// asserted here is the behaviour a view inherits for free and would
// otherwise have to be re-tested per page: search, pagination, the
// empty states, and keyboard access to a row.

interface Row {
  name: string;
  phase: string;
}

const COLUMNS: Column<Row>[] = [
  { key: "name", header: "Name", render: (r) => r.name, sortValue: (r) => r.name },
  {
    key: "phase",
    header: "Phase",
    render: (r) => r.phase,
    mono: true,
    sortValue: (r) => r.phase,
  },
];

/// A column with no `sortValue`, which is how a view says "this one
/// cannot be sorted" — a cell of chips has no order to speak of.
const UNSORTABLE: Column<Row>[] = [
  { key: "name", header: "Name", render: (r) => r.name },
];

/// The names in the body, top to bottom.
function names() {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.querySelectorAll("td")[0].textContent);
}

function rows(count: number, phase = "Running"): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `pod-${String(i).padStart(3, "0")}`,
    phase,
  }));
}

function renderTable(props: Partial<Parameters<typeof ResourceTable<Row>>[0]> = {}) {
  render(
    <ResourceTable<Row>
      columns={COLUMNS}
      rows={rows(3)}
      rowKey={(r) => r.name}
      searchText={(r) => `${r.name} ${r.phase}`}
      isLoading={false}
      {...props}
    />,
  );
  return userEvent.setup();
}

// Paged listings. The rule running through all of it: never imply the
// table holds the whole cluster when it does not. A search over a
// partly loaded listing that reports "3 of 500" as though 500 were
// everything is quietly wrong, and quietly wrong is the worst kind.
describe("ResourceTable partial results", () => {
  it("says nothing extra when it has everything", async () => {
    renderTable();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Showing the first/)).not.toBeInTheDocument();
  });

  it("says so when the cluster holds more than was loaded", async () => {
    renderTable({ hasMore: true, remaining: 19_500 });

    expect(screen.getByText(/Showing the first 3/)).toBeInTheDocument();
    // 3 loaded plus 19,500 still to come.
    expect(screen.getByText(/19503/)).toBeInTheDocument();
  });

  it("fetches the next page on request", async () => {
    const onLoadMore = vi.fn();
    const user = renderTable({ hasMore: true, onLoadMore });

    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(onLoadMore).toHaveBeenCalled();
  });

  it("does not ask twice while a page is in flight", async () => {
    renderTable({ hasMore: true, loadingMore: true });
    expect(screen.getByRole("button", { name: "Loading…" })).toBeDisabled();
  });

  it("warns that a search only covered what is loaded", async () => {
    // The specific way a paged table can mislead: you search, get
    // nothing, and conclude the object is not in the cluster.
    const user = renderTable({ hasMore: true, remaining: 19_500 });
    await user.type(screen.getByPlaceholderText("Search…"), "pod-001");

    expect(
      screen.getByText(/search covers only what is loaded/),
    ).toBeInTheDocument();
  });

  it("says nothing about search coverage when it has everything", async () => {
    const user = renderTable();
    await user.type(screen.getByPlaceholderText("Search…"), "pod-001");
    expect(
      screen.queryByText(/search covers only what is loaded/),
    ).not.toBeInTheDocument();
  });

  it("copes with a server that does not say how many remain", async () => {
    // remainingItemCount is advisory; plenty of servers omit it, and the
    // table must not render "of NaN".
    renderTable({ hasMore: true, remaining: null });

    expect(screen.getByText(/Showing the first 3/)).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });
});

describe("ResourceTable search", () => {
  it("narrows on every term rather than widening", async () => {
    // "kube running" should mean both, not either. An OR here would
    // make each extra word return more rows, which is the opposite of
    // what typing more words is for.
    const user = renderTable({
      rows: [
        { name: "kube-dns", phase: "Running" },
        { name: "kube-proxy", phase: "Pending" },
        { name: "app", phase: "Running" },
      ],
    });

    await user.type(screen.getByPlaceholderText("Search…"), "kube running");
    expect(screen.getByText("kube-dns")).toBeInTheDocument();
    expect(screen.queryByText("kube-proxy")).not.toBeInTheDocument();
    expect(screen.queryByText("app")).not.toBeInTheDocument();
  });

  it("matches regardless of case", async () => {
    const user = renderTable({ rows: [{ name: "Kube-DNS", phase: "Running" }] });
    await user.type(screen.getByPlaceholderText("Search…"), "kube-dns");
    expect(screen.getByText("Kube-DNS")).toBeInTheDocument();
  });

  it("reports how much of the set is showing", async () => {
    const user = renderTable({
      rows: [
        { name: "kube-dns", phase: "Running" },
        { name: "app", phase: "Running" },
      ],
    });
    expect(screen.getByText("2 items")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Search…"), "kube");
    expect(screen.getByText("1 of 2")).toBeInTheDocument();
  });

  it("names the query when nothing matches", async () => {
    // "Nothing to show" would read as an empty cluster rather than as a
    // filter the user can clear.
    const user = renderTable();
    await user.type(screen.getByPlaceholderText("Search…"), "zzz");
    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument();
    expect(screen.getByText(/zzz/)).toBeInTheDocument();
  });

  it("searches only what the row displays", async () => {
    // searchText is explicit rather than a stringified object, so a
    // match always corresponds to something the user can see.
    const user = renderTable({ searchText: (r: Row) => r.name });
    await user.type(screen.getByPlaceholderText("Search…"), "Running");
    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument();
  });
});

describe("ResourceTable sorting", () => {
  const UNSORTED: Row[] = [
    { name: "pod-b", phase: "Running" },
    { name: "pod-c", phase: "Failed" },
    { name: "pod-a", phase: "Pending" },
  ];

  it("leaves the rows in the server's order until asked", () => {
    // That order is what `kubectl get` prints, so it is a real answer
    // rather than an arbitrary starting point.
    renderTable({ rows: UNSORTED });
    expect(names()).toEqual(["pod-b", "pod-c", "pod-a"]);
  });

  it("sorts ascending on the first click", async () => {
    const user = renderTable({ rows: UNSORTED });
    await user.click(screen.getByRole("button", { name: /Name/ }));
    expect(names()).toEqual(["pod-a", "pod-b", "pod-c"]);
  });

  it("reverses on the second, and returns to the server's order on the third", async () => {
    const user = renderTable({ rows: UNSORTED });
    const header = screen.getByRole("button", { name: /Name/ });

    await user.click(header);
    await user.click(header);
    expect(names()).toEqual(["pod-c", "pod-b", "pod-a"]);

    await user.click(header);
    expect(names()).toEqual(["pod-b", "pod-c", "pod-a"]);
  });

  it("starts the new column ascending when a different header is clicked", async () => {
    const user = renderTable({ rows: UNSORTED });
    await user.click(screen.getByRole("button", { name: /Name/ }));
    await user.click(screen.getByRole("button", { name: /Name/ }));
    await user.click(screen.getByRole("button", { name: /Phase/ }));

    expect(names()).toEqual(["pod-c", "pod-a", "pod-b"]);
  });

  it("says which column is sorted, and which way", async () => {
    const user = renderTable({ rows: UNSORTED });
    const name = () => screen.getByRole("columnheader", { name: /Name/ });
    expect(name()).toHaveAttribute("aria-sort", "none");

    await user.click(screen.getByRole("button", { name: /Name/ }));
    expect(name()).toHaveAttribute("aria-sort", "ascending");

    await user.click(screen.getByRole("button", { name: /Name/ }));
    expect(name()).toHaveAttribute("aria-sort", "descending");
  });

  it("leaves a column with nothing to sort by inert", () => {
    // A cell of chips has no order to speak of, and a header that looks
    // clickable but does nothing is worse than one that does not.
    renderTable({ columns: UNSORTABLE });
    expect(
      screen.queryByRole("button", { name: /Name/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Name" })).not.toHaveAttribute(
      "aria-sort",
    );
  });

  it("sorts the whole set rather than the page on screen", async () => {
    // Sorting only the visible page would put the smallest of the first
    // fifty at the top and call it the smallest.
    const user = renderTable({ rows: rows(120) });
    await user.click(screen.getByRole("button", { name: /Name/ }));
    await user.click(screen.getByRole("button", { name: /Name/ }));

    expect(names()[0]).toBe("pod-119");
  });

  it("returns to the first page, where the rows now are", async () => {
    const user = renderTable({ rows: rows(120) });
    await user.click(screen.getByRole("button", { name: "›" }));
    expect(screen.getByText("2 / 3")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Name/ }));
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
  });

  it("sorts within a search rather than across everything", async () => {
    const user = renderTable({
      rows: [
        { name: "kube-b", phase: "Running" },
        { name: "app", phase: "Running" },
        { name: "kube-a", phase: "Running" },
      ],
    });
    await user.type(screen.getByPlaceholderText("Search…"), "kube");
    await user.click(screen.getByRole("button", { name: /Name/ }));

    expect(names()).toEqual(["kube-a", "kube-b"]);
  });

  it("warns that a sort only covered what is loaded", async () => {
    // A sort hides a partial listing better than a search does: the rows
    // come back convincingly ordered with the real top of the list still
    // sitting on the server.
    const user = renderTable({ hasMore: true, remaining: 19_500 });
    await user.click(screen.getByRole("button", { name: /Name/ }));

    expect(
      screen.getByText(/the sort covers only what is loaded/),
    ).toBeInTheDocument();
  });

  it("names both when a search and a sort are in play", async () => {
    const user = renderTable({ hasMore: true, remaining: 19_500 });
    await user.type(screen.getByPlaceholderText("Search…"), "pod");
    await user.click(screen.getByRole("button", { name: /Name/ }));

    expect(
      screen.getByText(/search and sort cover only what is loaded/),
    ).toBeInTheDocument();
  });
});

describe("ResourceTable pagination", () => {
  it("stays on one page for a set that fits", () => {
    renderTable({ rows: rows(50) });
    expect(screen.queryByText("1 / 2")).not.toBeInTheDocument();
  });

  it("pages a set that does not fit", async () => {
    const user = renderTable({ rows: rows(120) });
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
    expect(screen.getByText("pod-000")).toBeInTheDocument();
    expect(screen.queryByText("pod-050")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "›" }));
    expect(screen.getByText("pod-050")).toBeInTheDocument();
    expect(screen.queryByText("pod-000")).not.toBeInTheDocument();
    expect(screen.getByText("51–100 of 120")).toBeInTheDocument();
  });

  it("cannot page past either end", async () => {
    const user = renderTable({ rows: rows(120) });
    expect(screen.getByRole("button", { name: "‹" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "›" }));
    await user.click(screen.getByRole("button", { name: "›" }));
    expect(screen.getByText("3 / 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "›" })).toBeDisabled();
  });

  it("returns to the first page when a search shrinks the set", async () => {
    // Otherwise the user searches from page 3 and gets an empty table
    // sitting under a non-zero result count.
    const user = renderTable({ rows: rows(120) });
    await user.click(screen.getByRole("button", { name: "›" }));
    expect(screen.getByText("pod-050")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText("Search…"), "pod-00");
    expect(screen.getByText("pod-000")).toBeInTheDocument();
  });
});

describe("ResourceTable states", () => {
  it("shows placeholders rather than an empty table while loading", () => {
    renderTable({ isLoading: true, rows: undefined });
    // No "0 items" count, which would claim the cluster is empty before
    // anything has been read.
    expect(screen.queryByText("0 items")).not.toBeInTheDocument();
  });

  it("uses the caller's wording for an empty set", () => {
    renderTable({
      rows: [],
      empty: "No events. Kubernetes discards them after about an hour.",
    });
    expect(screen.getByText(/discards them/)).toBeInTheDocument();
  });

  it("renders a toolbar beside the search box", () => {
    renderTable({ toolbar: <button>Wide</button> });
    expect(screen.getByRole("button", { name: "Wide" })).toBeInTheDocument();
  });
});

describe("Table rows", () => {
  it("opens a row on click when it is clickable", async () => {
    const onRowClick = vi.fn();
    const user = userEvent.setup();
    render(
      <Table
        columns={COLUMNS}
        rows={rows(1)}
        rowKey={(r) => r.name}
        onRowClick={onRowClick}
      />,
    );

    await user.click(screen.getByText("pod-000"));
    expect(onRowClick).toHaveBeenCalledWith(
      { name: "pod-000", phase: "Running" },
      "here",
    );
  });

  it("asks for a new tab when a row is clicked with the modifier held", async () => {
    // The row reports how it was opened and lets the caller decide what
    // that means, the same way a link does.
    const onRowClick = vi.fn();
    const user = userEvent.setup();
    render(
      <Table
        columns={COLUMNS}
        rows={rows(1)}
        rowKey={(r) => r.name}
        onRowClick={onRowClick}
      />,
    );

    await user.keyboard("{Meta>}");
    await user.click(screen.getByText("pod-000"));
    await user.keyboard("{/Meta}");

    expect(onRowClick).toHaveBeenCalledWith(expect.anything(), "newTab");
  });

  it("opens a row from the keyboard", async () => {
    // A resource list that can only be driven with a mouse is a list
    // half the people using a terminal client cannot use.
    const onRowClick = vi.fn();
    const user = userEvent.setup();
    render(
      <Table
        columns={COLUMNS}
        rows={rows(1)}
        rowKey={(r) => r.name}
        onRowClick={onRowClick}
      />,
    );

    await user.tab();
    await user.keyboard("{Enter}");
    expect(onRowClick).toHaveBeenCalledOnce();

    await user.keyboard(" ");
    expect(onRowClick).toHaveBeenCalledTimes(2);
  });

  it("is not focusable when a row does nothing", async () => {
    // A tab stop that goes nowhere is worse than no tab stop.
    const user = userEvent.setup();
    render(<Table columns={COLUMNS} rows={rows(1)} rowKey={(r) => r.name} />);

    const row = screen.getByText("pod-000").closest("tr")!;
    expect(row).not.toHaveAttribute("tabindex");
    await user.tab();
    expect(row).not.toHaveFocus();
  });

  it("renders the headers the columns declare", () => {
    render(<Table columns={COLUMNS} rows={rows(1)} rowKey={(r) => r.name} />);
    const header = screen.getAllByRole("row")[0];
    expect(within(header).getByText("Name")).toBeInTheDocument();
    expect(within(header).getByText("Phase")).toBeInTheDocument();
  });
});
