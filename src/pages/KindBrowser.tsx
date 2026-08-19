import { TableBrowser } from "../components/TableBrowser";
import type { KindEntry } from "../lib/kinds";
import type { ListView, OpenIntent } from "../lib/routes";
import type { TableRow } from "../lib/api";

// One kind's listing, with the columns the API server printed.
//
// Every sidebar entry below Cluster lands here, and so does every custom
// resource. Nothing in this file knows what kind it is showing — the
// columns come from the server.
//
// This used to hold the object open from the listing, and a linked list
// of the ones opened before it, because following a related object
// leaves the kind the listing shows: from a Deployment you reach its
// ReplicaSet, from there its Pods, and from a Pod the ConfigMap it
// mounts. That chain is now the tab's history, which means it can be
// walked forwards as well as back, survives switching to another tab,
// and is the same mechanism whether the chain started here or in the
// pod list.

export function KindBrowser({
  entry,
  onOpen,
  view,
  onView,
}: {
  entry: KindEntry;
  onOpen: (row: TableRow, intent: OpenIntent) => void;
  view: ListView;
  onView: (patch: Partial<ListView>) => void;
}) {
  return (
    <TableBrowser
      // Keyed on the kind so switching kinds refetches and resets the
      // namespace filter rather than showing one kind's rows under
      // another's heading for a frame.
      key={entry.id}
      resource={entry.gvk}
      title={entry.label}
      subtitle={
        entry.gvk.group
          ? `${entry.gvk.group}/${entry.gvk.version}`
          : `core/${entry.gvk.version}`
      }
      onOpen={onOpen}
      view={view}
      onView={onView}
    />
  );
}
