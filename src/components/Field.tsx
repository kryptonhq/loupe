import { useState, type ReactNode } from "react";
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

/// Labels and node roles — short key/value pairs. Rendered as chips so
/// a set of eight reads as eight things rather than one long line.
///
/// Only safe for values that are actually short. Kubernetes caps a label
/// value at 63 characters, which is what makes a non-wrapping chip the
/// right shape here. Annotations have no such cap; they get `Annotations`
/// below.
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

/// Anything past this is folded away until asked for. Roughly three
/// lines at the width these panes run to — enough to see what an
/// annotation is, short of letting one own the page.
const LONG_VALUE = 240;

/// One annotation: the key, then its value beneath.
///
/// Two columns would be the obvious layout and it is the wrong one. An
/// annotation value can be a whole serialised object —
/// `last-applied-configuration` routinely runs to kilobytes — and a
/// value column narrow enough to leave room for keys is a column that
/// wraps every long value into a thin ribbon.
function Annotation({ name, value }: { name: string; value: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = value.length > LONG_VALUE;

  return (
    <li className="min-w-0 rounded border px-2 py-1.5">
      <p className="break-all font-mono text-2xs text-content-muted">{name}</p>
      <p
        // `break-all`, not `break-words`: serialised JSON has no spaces
        // to break at, so a word-boundary rule would find none and let
        // the line run off the side of the window — taking the page's
        // horizontal scrollbar with it.
        className={`mt-0.5 whitespace-pre-wrap break-all font-mono text-2xs ${
          long && !expanded ? "line-clamp-3" : ""
        }`}
      >
        {value}
      </p>
      {long && (
        <button
          onClick={() => setExpanded((e) => !e)}
          className="mt-1 rounded-sm text-2xs text-accent transition-colors hover:underline"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </li>
  );
}

/// Annotations, which are unbounded in length and frequently enormous.
export function Annotations({ pairs }: { pairs: [string, string][] }) {
  if (pairs.length === 0) return null;
  return (
    <Section title="Annotations">
      <ul className="space-y-1.5">
        {pairs.map(([k, v]) => (
          <Annotation key={k} name={k} value={v} />
        ))}
      </ul>
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
