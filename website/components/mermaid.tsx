'use client';

import { useEffect, useId, useState } from 'react';
import { useTheme } from 'next-themes';

/**
 * Renders a Mermaid diagram.
 *
 * Mermaid draws in the browser, so the diagram is rendered after mount and
 * re-rendered when the colour scheme changes. Diagrams come from this repository's
 * own MDX, never from user input, and Mermaid is initialised with its strict
 * security level, which sanitises the SVG it produces.
 */
export function Mermaid({ chart }: { chart: string }) {
  const id = useId().replace(/:/g, '');
  const { resolvedTheme } = useTheme();
  const [svg, setSvg] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    void (async () => {
      const { default: mermaid } = await import('mermaid');
      const dark = resolvedTheme === 'dark';

      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        fontFamily: 'var(--font-sans), sans-serif',
        theme: 'base',
        themeVariables: {
          // Loupe's palette, so diagrams sit in the page rather than on top of it.
          background: 'transparent',
          primaryColor: dark ? '#1e2330' : '#eef0ff',
          primaryBorderColor: dark ? '#8184f8' : '#6366f1',
          primaryTextColor: dark ? '#e4e9f2' : '#0f172a',
          lineColor: dark ? '#6a7489' : '#8b94a5',
          secondaryColor: dark ? '#171b25' : '#f8fafd',
          tertiaryColor: dark ? '#11151d' : '#edf0f6',
          actorBkg: dark ? '#1e2330' : '#eef0ff',
          actorBorder: dark ? '#8184f8' : '#6366f1',
          actorTextColor: dark ? '#e4e9f2' : '#0f172a',
          signalColor: dark ? '#9aa4b8' : '#475569',
          signalTextColor: dark ? '#9aa4b8' : '#475569',
          noteBkgColor: dark ? '#171b25' : '#fdf6e8',
          noteTextColor: dark ? '#e4e9f2' : '#8a5300',
          noteBorderColor: dark ? '#2b3140' : '#e2b872',
        },
      });

      const { svg } = await mermaid.render(`mermaid-${id}`, chart.trim());
      if (active) setSvg(svg);
    })();

    return () => {
      active = false;
    };
  }, [chart, id, resolvedTheme]);

  return (
    <figure className="my-6 overflow-x-auto rounded-lg border border-fd-border bg-fd-card p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full">
      {svg ? (
        <div dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <p className="py-6 text-center text-sm text-fd-muted-foreground">Drawing diagram…</p>
      )}
    </figure>
  );
}
