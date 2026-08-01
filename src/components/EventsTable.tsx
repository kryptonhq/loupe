import { useQuery } from "@tanstack/react-query";
import { ResourceTable } from "./ResourceTable";
import { type Column } from "./Table";
import { Chip, eventTone } from "./Chip";
import { ErrorStrip } from "./Panel";
import { api, type EventView } from "../lib/api";

// The Events tab, shared by every detail page.
//
// Two modes: events *about* one object, and every event *in* a
// namespace. The second needs a Subject column — with a hundred events
// from a hundred pods, the object is the first thing you read — and the
// first must not have one, where it would repeat the page title on every
// row.

interface EventsTableProps {
  namespace: string;
  /// The object to filter on. Omitted for the whole-namespace view.
  name?: string;
}

export function EventsTable({ namespace, name }: EventsTableProps) {
  const q = useQuery({
    queryKey: name
      ? ["events", namespace, name]
      : ["namespace-events", namespace],
    queryFn: () =>
      name ? api.listEvents(namespace, name) : api.listNamespaceEvents(namespace),
  });

  const columns: Column<EventView>[] = [
    {
      key: "type",
      header: "Type",
      render: (e) => <Chip tone={eventTone(e.type)}>{e.type}</Chip>,
    },
    ...(name
      ? []
      : [
          {
            key: "object",
            header: "Subject",
            render: (e: EventView) => e.object ?? "—",
          },
        ]),
    {
      key: "reason",
      header: "Reason",
      render: (e) => (e.reason ? <Chip tone="accent">{e.reason}</Chip> : "—"),
    },
    { key: "message", header: "Message", render: (e) => e.message ?? "—" },
    { key: "count", header: "Count", render: (e) => e.count ?? 1, mono: true },
    { key: "age", header: "Age", render: (e) => e.age ?? "—", mono: true },
  ];

  return (
    <>
      {q.error != null && <ErrorStrip error={q.error} />}
      <ResourceTable
        columns={columns}
        rows={q.data}
        isLoading={q.isLoading}
        // Repeated events can be identical in every field, so the index
        // is the only stable key available.
        rowKey={(_, i) => String(i)}
        searchText={(e) =>
          `${e.type} ${e.reason ?? ""} ${e.message ?? ""} ${e.object ?? ""}`
        }
        empty="No events. Kubernetes discards them after about an hour."
      />
    </>
  );
}
