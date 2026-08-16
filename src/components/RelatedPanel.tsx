import { useQuery } from "@tanstack/react-query";
import { Panel } from "./Panel";
import { SkeletonRows } from "./Skeleton";
import { api, type GvkRef, type Relation, type RelatedObject } from "../lib/api";

// The Related tab: everything one object connects to.
//
// This is the answer to "why would I use a GUI rather than a TUI".
// Speed is not the answer — a terminal wins on speed. Following a graph
// is: tracing "this ingress → this service → these pods → this config"
// is several `kubectl get -o yaml` calls and some manual selector
// matching, and here it is one click each.

/// Section headings, in the order they read best: up the ownership
/// chain first (which is what someone looking at a pod usually wants),
/// then down, then sideways.
const SECTIONS: { relation: Relation; title: string; hint: string }[] = [
  { relation: "ownedBy", title: "Owned by", hint: "Walked up ownerReferences" },
  { relation: "owns", title: "Owns", hint: "Objects created by this one" },
  { relation: "selectedBy", title: "Selected by", hint: "Their selector matches this object's labels" },
  { relation: "selects", title: "Selects", hint: "This object's selector matches them" },
  { relation: "routes", title: "Routes", hint: "Ingress rules either side of this object" },
  { relation: "uses", title: "Uses", hint: "Named in this object's own spec" },
];

export interface RelatedTarget {
  resource: GvkRef;
  namespace: string | null;
  name: string;
}

export function RelatedPanel({
  target,
  onOpen,
}: {
  target: RelatedTarget;
  /// Opening a related object is the whole point; a panel that only
  /// lists them is a worse version of `kubectl describe`.
  onOpen: (related: RelatedObject) => void;
}) {
  const q = useQuery({
    queryKey: [
      "related",
      target.resource.group,
      target.resource.version,
      target.resource.kind,
      target.namespace,
      target.name,
    ],
    queryFn: () =>
      api.listRelated(target.resource, target.namespace, target.name),
  });

  const related = q.data ?? [];

  return (
    <Panel
      title="Related"
      subtitle="Resolved from ownerReferences, selectors and this object's own spec"
      error={q.error}
      isFetching={q.isFetching && !q.isLoading}
      onRefresh={() => q.refetch()}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        {q.isLoading ? (
          <SkeletonRows columns={2} />
        ) : related.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-content-muted">
            Nothing references this object, and it references nothing.
          </p>
        ) : (
          SECTIONS.map(({ relation, title, hint }) => {
            const rows = related.filter((r) => r.relation === relation);
            if (rows.length === 0) return null;
            return (
              <section key={relation}>
                <p
                  title={hint}
                  className="border-b bg-content/[0.02] px-4 py-1 text-2xs font-medium uppercase tracking-wide text-content-muted"
                >
                  {title}
                </p>
                {rows.map((row) => (
                  <RelatedRow
                    key={`${row.relation}/${row.kind}/${row.namespace ?? ""}/${row.name}`}
                    row={row}
                    onOpen={() => onOpen(row)}
                  />
                ))}
              </section>
            );
          })
        )}
      </div>
    </Panel>
  );
}

function RelatedRow({
  row,
  onOpen,
}: {
  row: RelatedObject;
  onOpen: () => void;
}) {
  // An unreadable object is still worth showing — "you cannot see what
  // owns this" is a useful answer — but it must not look like a link
  // that does nothing.
  if (!row.reachable) {
    return (
      <div className="flex items-center gap-2 border-b border-hairline/[0.06] px-4 py-2 text-sm">
        <span className="shrink-0 text-2xs text-content-muted">{row.kind}</span>
        <span className="min-w-0 flex-1 truncate text-content-muted line-through">
          {row.name}
        </span>
        <span
          className="shrink-0 text-2xs text-warn"
          title="Referenced, but it could not be read — deleted, or your RBAC does not allow it"
        >
          unreadable
        </span>
      </div>
    );
  }

  return (
    <button
      onClick={onOpen}
      className="flex w-full items-center gap-2 border-b border-hairline/[0.06] px-4 py-2 text-left text-sm transition-colors duration-150 ease-swift hover:bg-content/[0.05]"
    >
      <span className="shrink-0 text-2xs text-content-muted">{row.kind}</span>
      <span className="min-w-0 flex-1 truncate font-medium">{row.name}</span>
      {row.detail && (
        <span className="shrink-0 truncate text-2xs text-content-muted">
          {row.detail}
        </span>
      )}
      <span className="shrink-0 text-xs text-content-muted">→</span>
    </button>
  );
}
