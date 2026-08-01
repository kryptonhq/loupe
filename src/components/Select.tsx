import type { ReactNode } from "react";

// A native <select> with the platform chrome removed.
//
// The native control is kept — it gets keyboard behaviour, type-ahead
// and the OS popup for free, none of which a div-based menu reproduces
// well. Only the closed-state appearance is ours, because the stock
// button is the one element that visibly ignores the theme.

export function Select({
  value,
  onChange,
  children,
  title,
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className="relative inline-flex shrink-0 items-center">
      <select
        value={value}
        title={title}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none rounded-sm border bg-content/[0.03] py-1 pl-2.5 pr-7 text-sm transition-colors duration-150 ease-swift hover:bg-content/[0.06] focus:border-accent/40"
      >
        {children}
      </select>
      {/* Chevron sits over the control; pointer-events off so clicks
          still reach the select underneath. */}
      <span className="pointer-events-none absolute right-2 text-2xs text-content-muted">
        ▾
      </span>
    </span>
  );
}
