import { routeLabel, routeTitle, type Route } from "../lib/routes";

// Back, forward, and the path that got you here.
//
// The crumbs are the tab's own history, not a hierarchy invented for
// display: from a pod you reach its ReplicaSet, from there the
// Deployment above it, and from there the Service that selects it —
// none of which is a containment tree, and all of which is the route
// you actually took. Clicking a crumb walks back to it without
// discarding what is ahead, so the trip is reversible in both
// directions.
//
// Rendered only once a tab has somewhere to go back to. At the top of a
// tab there is no path, and a bar showing one disabled arrow is chrome
// paying no rent.

interface TrailBarProps {
  trail: Route[];
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onCrumb: (index: number) => void;
}

const ARROW =
  "rounded-sm px-1.5 text-xs transition-colors duration-150 ease-swift disabled:opacity-30 enabled:hover:bg-content/[0.06] enabled:hover:text-content";

export function TrailBar({
  trail,
  canBack,
  canForward,
  onBack,
  onForward,
  onCrumb,
}: TrailBarProps) {
  const last = trail.length - 1;

  return (
    <nav
      aria-label="Trail"
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
        {trail.map((route, i) => (
          <li key={i} className="flex min-w-0 items-center gap-1">
            {i > 0 && (
              <span aria-hidden className="text-content-muted/60">
                ›
              </span>
            )}
            {i === last ? (
              // Where you are. Not a button: there is nowhere for it to
              // go, and offering the click implies otherwise.
              <span
                aria-current="page"
                title={routeTitle(route)}
                className="truncate font-medium text-content"
              >
                {routeLabel(route)}
              </span>
            ) : (
              <button
                onClick={() => onCrumb(i)}
                title={`Back to ${routeTitle(route)}`}
                className="truncate rounded-sm px-1 transition-colors hover:bg-content/[0.06] hover:text-content"
              >
                {routeLabel(route)}
              </button>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
