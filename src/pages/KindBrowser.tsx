import { useState } from "react";
import { TableBrowser } from "../components/TableBrowser";
import { ObjectDetail } from "./ObjectDetail";
import type { KindEntry } from "../lib/kinds";
import type { GvkRef, TableRow } from "../lib/api";

// One kind: its listing, and whichever object is open from it.
//
// Every sidebar entry below Cluster lands here, and so does every custom
// resource. Nothing in this file knows what kind it is showing — the
// listing's columns come from the API server and the detail view reads
// whatever the object turns out to have.
//
// What is open is held as a full descriptor rather than as a row from
// the table, because following a related object leaves the kind the
// listing is showing: from a Deployment you reach its ReplicaSet, from
// there its Pods, and from a Pod the ConfigMap it mounts. The listing
// stays put; only the detail view moves.

interface Open {
  resource: GvkRef;
  namespace: string | null;
  name: string;
  /// What the back button returns to. Once you have followed a chain,
  /// that is the object you came from rather than the listing.
  backTo: string;
  /// Where to return to on close. Null returns to the listing.
  from: Open | null;
}

export function KindBrowser({ entry }: { entry: KindEntry }) {
  const [open, setOpen] = useState<Open | null>(null);
  const [shown, setShown] = useState(entry.id);

  // Changing kinds drops whatever was open. An Agent named mcp-hello is
  // not a Model named mcp-hello, and carrying the selection across would
  // send the detail view looking for an object that does not exist.
  //
  // Done here rather than with a `key` on the caller, so the guarantee
  // belongs to the component that holds the state instead of to every
  // place that renders it. Adjusting state during render is React's own
  // recommendation for this, and costs no extra paint.
  if (shown !== entry.id) {
    setShown(entry.id);
    setOpen(null);
    return null;
  }

  if (open) {
    return (
      <ObjectDetail
        // Keyed so following a related object remounts rather than
        // showing the previous object's tab state over the new one.
        key={`${open.resource.kind}/${open.namespace ?? ""}/${open.name}`}
        resource={open.resource}
        namespace={open.namespace}
        name={open.name}
        backTo={open.backTo}
        onClose={() => setOpen(open.from)}
        onOpenRelated={(related) =>
          setOpen({
            resource: {
              group: related.group,
              version: related.version,
              kind: related.kind,
            },
            namespace: related.namespace,
            name: related.name,
            backTo: open.name,
            from: open,
          })
        }
      />
    );
  }

  return (
    <TableBrowser
      resource={entry.gvk}
      title={entry.label}
      subtitle={
        entry.gvk.group
          ? `${entry.gvk.group}/${entry.gvk.version}`
          : `core/${entry.gvk.version}`
      }
      onOpen={(row: TableRow) =>
        setOpen({
          resource: entry.gvk,
          namespace: row.namespace,
          name: row.name,
          backTo: entry.label.toLowerCase(),
          from: null,
        })
      }
    />
  );
}
