import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Panel } from "./Panel";
import { ResourceTable } from "./ResourceTable";
import { type Column } from "./Table";
import { Select } from "./Select";
import { StatusDot } from "./StatusDot";
import { api, type GvkRef, type TableRow } from "../lib/api";
import { statusTone } from "../pages/ObjectDetail";

// A listing for any kind, with the columns the API server printed.
//
// Nothing here knows what a Service or a CronJob is. The server sends
// the same column definitions kubectl would print — including whatever
// `additionalPrinterColumns` a CRD author defined — and this renders
// them. That is why one component covers workloads, networking, config,
// storage and every custom resource at once, and why it keeps working
// for kinds this build has never heard of.

/// Column names whose cells read better as a status than as text.
///
/// Deliberately small: guessing wrong paints a healthy row red. These
/// are the names Kubernetes' own printers use for a health verdict.
const STATUS_COLUMNS = new Set(["status", "state", "phase", "ready", "available"]);

/// Cells the server prints for "nothing here".
function isEmptyCell(value: string) {
  return value === "" || value === "<none>" || value === "<unset>";
}

interface TableBrowserProps {
  resource: GvkRef;
  title: string;
  /// Rendered under the title — the API group, usually.
  subtitle?: string;
  onOpen: (row: TableRow) => void;
  /// Extra controls for the panel header.
  actions?: React.ReactNode;
}

export function TableBrowser({
  resource,
  title,
  subtitle,
  onOpen,
  actions,
}: TableBrowserProps) {
  const [namespace, setNamespace] = useState("");
  // Kubectl calls these `-o wide`. Off by default for the same reason:
  // Selector and Images columns are long enough to squeeze everything
  // else off a narrow pane.
  const [wide, setWide] = useState(false);

  const q = useQuery({
    queryKey: ["table", resource.group, resource.version, resource.kind, namespace],
    queryFn: () => api.listTable(resource, namespace || undefined),
    placeholderData: (prev) => prev,
  });

  const namespaces = useQuery({
    queryKey: ["namespaces"],
    queryFn: () => api.listNamespaces(),
    enabled: q.data?.namespaced ?? false,
  });

  const columns: Column<TableRow>[] = useMemo(() => {
    const table = q.data;
    if (!table) return [];

    const visible = table.columns
      .map((column, index) => ({ column, index }))
      .filter(({ column }) => wide || column.priority === 0);

    const cells = visible.map(({ column, index }) => {
      const status = STATUS_COLUMNS.has(column.name.toLowerCase());
      return {
        key: `${index}`,
        header: column.name,
        // The server's description makes a genuinely good tooltip, and
        // it is the only explanation of a CRD's own columns anywhere.
        render: (row: TableRow) => {
          const value = row.cells[index] ?? "";
          if (isEmptyCell(value)) {
            return <span className="text-content-muted">—</span>;
          }
          return status ? (
            <StatusDot tone={statusTone(value)} label={value} />
          ) : (
            value
          );
        },
        mono: !status && /age|ports?|ip|capacity|size|version/i.test(column.name),
      } satisfies Column<TableRow>;
    });

    // A cluster-wide listing needs to say where each object lives, and
    // the server's own columns never include it.
    if (table.namespaced && !namespace) {
      cells.splice(1, 0, {
        key: "namespace",
        header: "Namespace",
        render: (row: TableRow) => row.namespace ?? "—",
        mono: false,
      });
    }
    return cells;
  }, [q.data, wide, namespace]);

  const hasWideColumns = (q.data?.columns ?? []).some((c) => c.priority > 0);

  return (
    <Panel
      title={title}
      subtitle={subtitle}
      error={q.error}
      isFetching={q.isFetching && !q.isLoading}
      onRefresh={() => q.refetch()}
      actions={actions}
    >
      <ResourceTable
        columns={columns}
        rows={q.data?.rows}
        isLoading={q.isLoading}
        rowKey={(row) => `${row.namespace ?? ""}/${row.name}`}
        searchText={(row) => `${row.name} ${row.namespace ?? ""} ${row.cells.join(" ")}`}
        empty={`No ${title.toLowerCase()} here.`}
        onRowClick={onOpen}
        toolbar={
          <>
            {q.data?.namespaced && (
              <Select value={namespace} onChange={setNamespace}>
                <option value="">All namespaces</option>
                {(namespaces.data ?? []).map((ns) => (
                  <option key={ns.name} value={ns.name}>
                    {ns.name}
                  </option>
                ))}
              </Select>
            )}
            {hasWideColumns && (
              <label
                className="flex shrink-0 items-center gap-1.5 text-2xs text-content-secondary"
                title="Show the extra columns kubectl keeps for -o wide"
              >
                <input
                  type="checkbox"
                  checked={wide}
                  onChange={(e) => setWide(e.target.checked)}
                />
                Wide
              </label>
            )}
          </>
        }
      />
    </Panel>
  );
}
