import type { Crumb, Route } from "../lib/routes";

// Back, forward, and where the thing on screen sits.
//
// The crumbs are derived from the current route alone — a DaemonSet
// shows "DaemonSets › monitoring › prom-node-exporter" wherever you
// came from. They used to be the tab's visited history, which read
// "Nodes › Pods › some-pod › Jobs › DaemonSets › some-daemonset": a
// record of wandering, dressed up as a hierarchy it does not have.
//
// Where you have been is a different question, and the arrows already
// answer it. Keeping the two apart means each says one true thing.

interface TrailBarProps {
  crumbs: Crumb[];
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onCrumb: (route: Route) => void;
}

const ARROW =
  "rounded-sm px-1.5 text-xs transition-colors duration-150 ease-swift disabled:opacity-30 enabled:hover:bg-content/[0.06] enabled:hover:text-content";

export function TrailBar({
  crumbs,
  canBack,
  canForward,
  onBack,
  onForward,
  onCrumb,
}: TrailBarProps) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex shrink-0 items-center gap-1 border-b px-3 py-1.5 text-content-muted"
    >
      <button
        onClick={onBack}
        disabled={!canBack}
        aria-label="Back"
        title="Back (⌘[)"
        className={ARROW}
      >
        ←
      </button>
      <button
        onClick={onForward}
        disabled={!canForward}
        aria-label="Forward"
        title="Forward (⌘])"
        className={ARROW}
      >
        →
      </button>

      <ol className="ml-1 flex min-w-0 items-center gap-1 text-2xs">
        {crumbs.map((crumb, i) => (
          <li key={i} className="flex min-w-0 items-center gap-1">
            {i > 0 && (
              <span aria-hidden className="text-content-muted/60">
                ›
              </span>
            )}
            {crumb.route ? (
              <button
                onClick={() => onCrumb(crumb.route!)}
                title={`Go to ${crumb.title}`}
                className="truncate rounded-sm px-1 transition-colors hover:bg-content/[0.06] hover:text-content"
              >
                {crumb.label}
              </button>
            ) : (
              // Where you are. Not a button: there is nowhere for it to
              // go, and offering the click implies otherwise.
              <span
                aria-current="page"
                title={crumb.title}
                className="truncate font-medium text-content"
              >
                {crumb.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
