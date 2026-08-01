import { THEMES, type Theme } from "../lib/theme";

// Three segments rather than a dropdown: there are exactly three
// choices, they never grow, and a segmented control shows the current
// one without being opened.

export function ThemePicker({
  theme,
  onChange,
}: {
  theme: Theme;
  onChange: (theme: Theme) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Appearance"
      className="flex gap-0.5 rounded-sm bg-content/[0.04] p-0.5"
    >
      {THEMES.map((option) => {
        const active = option.id === theme;
        return (
          <button
            key={option.id}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.id)}
            className={`flex-1 rounded-[3px] px-1.5 py-0.5 text-2xs transition-colors duration-150 ease-swift ${
              active
                ? "bg-content/[0.10] font-medium text-content"
                : "text-content-muted hover:text-content-secondary"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
