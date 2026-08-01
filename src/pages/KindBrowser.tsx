import { useState } from "react";
import { TableBrowser } from "../components/TableBrowser";
import { ObjectDetail } from "./ObjectDetail";
import type { KindEntry } from "../lib/kinds";
import type { TableRow } from "../lib/api";

// One kind: its listing, and whichever object is open from it.
//
// Every sidebar entry below Cluster lands here, and so does every custom
// resource. Nothing in this file knows what kind it is showing — the
// listing's columns come from the API server and the detail view reads
// whatever the object turns out to have.

export function KindBrowser({ entry }: { entry: KindEntry }) {
  const [selected, setSelected] = useState<TableRow | null>(null);
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
    setSelected(null);
    return null;
  }

  if (selected) {
    return (
      <ObjectDetail
        resource={entry.gvk}
        namespace={selected.namespace}
        name={selected.name}
        backTo={entry.label.toLowerCase()}
        onClose={() => setSelected(null)}
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
      onOpen={setSelected}
    />
  );
}
