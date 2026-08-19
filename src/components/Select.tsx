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
  dense,
}: {
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  title?: string;
  /// For the status bar, where the row is shorter than a toolbar's and
  /// a full-size control would set the height of the whole line.
  dense?: boolean;
}) {
  return (
    <span className="relative inline-flex shrink-0 items-center">
      <select
        value={value}
        title={title}
        onChange={(e) => onChange(e.target.value)}
        className={`appearance-none rounded-sm border bg-content/[0.03] transition-colors duration-150 ease-swift hover:bg-content/[0.06] focus:border-accent/40 ${
          dense ? "py-0 pl-1.5 pr-5 text-2xs" : "py-1 pl-2.5 pr-7 text-sm"
        }`}
      >
        {children}
      </select>
      {/* Chevron sits over the control; pointer-events off so clicks
          still reach the select underneath. */}
      <span
        className={`pointer-events-none absolute text-2xs text-content-muted ${
          dense ? "right-1.5" : "right-2"
        }`}
      >
        ▾
      </span>
    </span>
  );
}
