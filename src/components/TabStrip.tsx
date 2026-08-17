import { routeLabel, routeTitle } from "../lib/routes";
import type { Tab } from "../lib/workspace";
import { dragRegionProps } from "../lib/window";

// The tabs across the top of the main area.
//
// One tab is one piece of work: a listing you keep coming back to, an
// object you are watching, a manifest you are part-way through reading.
// Before this the app held exactly one view, so opening a pod lost the
// list it came from and there was no way to hold a healthy replica
// beside a failing one.
//
// This is the window's top edge on macOS, so it carries the drag region
// and the padding that clears the traffic lights. Buttons inside opt
// out, or a click meant for a tab would move the window instead.

interface TabStripProps {
  tabs: Tab[];
  active: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}

export function TabStrip({
  tabs,
  active,
  onSelect,
  onClose,
  onNew,
}: TabStripProps) {
  return (
    <div
      {...dragRegionProps}
      role="tablist"
      aria-label="Open tabs"
      className="drag-region glass flex shrink-0 items-stretch border-b pt-9"
    >
      <div className="no-drag flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {tabs.map((tab) => {
          const route = tab.history[tab.index];
          const on = tab.id === active;
          return (
            <div
              key={tab.id}
              className={`group flex max-w-[13rem] shrink-0 items-center border-r transition-colors duration-150 ease-swift ${
                on
                  ? "bg-surface-1 shadow-[inset_0_2px_0_rgb(var(--accent))]"
                  : "hover:bg-content/[0.04]"
              }`}
            >
              <button
                role="tab"
                aria-selected={on}
                title={routeTitle(route)}
                onClick={() => onSelect(tab.id)}
                className={`min-w-0 py-1.5 pl-3 pr-2 text-left text-xs ${
                  on ? "font-medium text-content" : "text-content-secondary"
                }`}
              >
                <span className="block truncate">{routeLabel(route)}</span>
              </button>

              {/* Always rendered rather than shown on hover: a control
                  that appears under the pointer is one you cannot aim
                  for, and the row is too short for the shift. */}
              <button
                onClick={() => onClose(tab.id)}
                aria-label={`Close ${routeLabel(route)}`}
                className="mr-1.5 rounded-sm px-1 text-2xs text-content-muted transition-colors hover:bg-content/[0.08] hover:text-content"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>

      <button
        onClick={onNew}
        aria-label="New tab"
        title="New tab (⌘T)"
        className="no-drag shrink-0 border-l px-3 text-sm text-content-muted transition-colors hover:bg-content/[0.05] hover:text-content"
      >
        +
      </button>
    </div>
  );
}
