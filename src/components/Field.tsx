import type { ReactNode } from "react";
import { Chip } from "./Chip";

// The label/value primitives every overview tab is built from.

export function Field({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  // An explicitly absent value renders as an em dash rather than a gap,
  // so a missing field reads as "nothing here" and not as a broken row.
  const shown =
    value === null || value === undefined || value === "" ? "—" : value;
  return (
    <div className="flex gap-2 py-1 text-sm">
      <dt className="w-36 shrink-0 text-content-muted">{label}</dt>
      <dd className="min-w-0 break-words">{shown}</dd>
    </div>
  );
}

export function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-4">
      <h3 className="mb-1 text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/// Labels, annotations, node addresses — anything that is a bag of
/// key/value pairs. Rendered as chips so a set of eight reads as eight
/// things rather than one long line.
export function PairChips({
  pairs,
  title,
}: {
  pairs: [string, string][];
  title: string;
}) {
  if (pairs.length === 0) return null;
  return (
    <Section title={title}>
      <div className="flex flex-wrap gap-1">
        {pairs.map(([k, v]) => (
          <Chip key={k} mono title={`${k}=${v}`}>
            {k}={v}
          </Chip>
        ))}
      </div>
    </Section>
  );
}

/// A quantity map — a node's capacity, say — as aligned rows. Chips
/// would wrap badly here because the values are what you compare.
export function QuantityRows({ pairs }: { pairs: [string, string][] }) {
  if (pairs.length === 0) {
    return <p className="text-sm text-content-muted">—</p>;
  }
  return (
    <dl className="grid grid-cols-[minmax(0,14rem)_1fr] gap-x-3 text-sm">
      {pairs.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="truncate py-0.5 font-mono text-2xs text-content-muted">
            {k}
          </dt>
          <dd className="py-0.5 font-mono text-2xs tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
