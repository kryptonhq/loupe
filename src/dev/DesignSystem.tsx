import { useState } from "react";
import { Chip, ChipList, type ChipTone } from "../components/Chip";
import { StatusDot, type Tone } from "../components/StatusDot";
import { SkeletonBlock, SkeletonRows, RefreshingDot } from "../components/Skeleton";
import { Table, type Column } from "../components/Table";
import { YamlView } from "../components/YamlView";
import { Logo } from "../components/Logo";

// A living style guide, rendered inside the real app shell.
//
// This exists instead of Storybook. For a component set this size the
// tradeoff favours it: these components depend on the actual window —
// native vibrancy, the theme class on <html>, drag regions — and a
// component rendered in an isolated iframe gets all three wrong. Here
// they are shown in the shell they actually ship in.
//
// Dev-only. Reachable at ?design and stripped from production builds.

const SURFACES = [
  ["base", "bg-base"],
  ["surface-1", "bg-surface-1"],
  ["surface-2", "bg-surface-2"],
  ["surface-3", "bg-surface-3"],
] as const;

const SEMANTIC = [
  ["accent", "bg-accent"],
  ["success", "bg-success"],
  ["warn", "bg-warn"],
  ["danger", "bg-danger"],
  ["info", "bg-info"],
] as const;

const CHIP_TONES: ChipTone[] = [
  "neutral",
  "accent",
  "ok",
  "warn",
  "danger",
  "info",
];

const DOT_TONES: Tone[] = ["ok", "warn", "danger", "unknown"];

const SAMPLE_YAML = `apiVersion: v1
kind: Pod
metadata:
  name: sample
  labels:
    app: demo          # a trailing comment
spec:
  replicas: 3
  enabled: true
  ratio: 1.5
  version: 1.2.3       # not a number
  image: "ghcr.io/x/y:1.0"
  script: |
    echo "not: a key"
    # not a comment
  missing: null`;

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-10">
      <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      {note && <p className="mb-3 mt-0.5 text-2xs text-content-muted">{note}</p>}
      <div className={note ? "" : "mt-3"}>{children}</div>
    </section>
  );
}

function Swatch({ name, cls }: { name: string; cls: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className={`h-9 w-9 shrink-0 rounded border ${cls}`} />
      <span className="font-mono text-2xs text-content-secondary">{name}</span>
    </div>
  );
}

interface DemoRow {
  name: string;
  status: string;
  age: string;
}

export function DesignSystem() {
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );

  function toggleTheme() {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    setDark(next);
  }

  const columns: Column<DemoRow>[] = [
    { key: "name", header: "Name", render: (r) => r.name },
    {
      key: "status",
      header: "Status",
      render: (r) => <StatusDot tone="ok" label={r.status} />,
    },
    { key: "age", header: "Age", render: (r) => r.age, mono: true },
  ];

  const rows: DemoRow[] = [
    { name: "coredns-58db975755-wbhbz", status: "Running", age: "65d" },
    { name: "krypton-gateway-5f8b7d6c9-vkt4n", status: "Running", age: "12d" },
  ];

  return (
    <div className="ambient h-full overflow-y-auto">
      <header className="drag-region glass sticky top-0 z-20 flex items-center justify-between border-b px-6 pb-3 pt-10">
        <div className="flex items-center gap-2.5">
          <Logo className="h-6 w-6" />
          <span className="text-sm font-semibold tracking-tight">
            Loupe design system
          </span>
        </div>
        <button
          onClick={toggleTheme}
          className="no-drag rounded-sm border px-2 py-1 text-2xs text-content-secondary transition-colors hover:bg-content/[0.06] hover:text-content"
        >
          {dark ? "Light" : "Dark"}
        </button>
      </header>

      <div className="mx-auto max-w-3xl px-6 py-8">
        <Section
          title="Surfaces"
          note="Elevation runs base → 3. Components name the role, never a palette colour."
        >
          <div className="grid grid-cols-4 gap-3">
            {SURFACES.map(([n, c]) => (
              <Swatch key={n} name={n} cls={c} />
            ))}
          </div>
        </Section>

        <Section
          title="Semantic colour"
          note="Status is the only thing allowed to be colourful. Everything else is neutral."
        >
          <div className="grid grid-cols-5 gap-3">
            {SEMANTIC.map(([n, c]) => (
              <Swatch key={n} name={n} cls={c} />
            ))}
          </div>
        </Section>

        <Section title="Text" note="Three weights of emphasis, no more.">
          <p className="text-base text-content">content — primary</p>
          <p className="text-sm text-content-secondary">
            content-secondary — supporting detail
          </p>
          <p className="text-2xs text-content-muted">
            content-muted — metadata and labels
          </p>
          <p className="mt-2 font-mono text-xs tabular-nums text-content-secondary">
            mono tabular — 0123456789 · 2/2 · 65d
          </p>
        </Section>

        <Section
          title="Glass"
          note="Translucent panels blur what is behind them. Over the desktop itself when native vibrancy is active."
        >
          <div className="relative h-32 overflow-hidden rounded-lg bg-gradient-to-br from-accent/40 via-info/30 to-success/30">
            <div className="glass absolute inset-x-6 inset-y-5 rounded border p-3">
              <p className="text-xs font-medium">.glass</p>
              <p className="text-2xs text-content-secondary">
                sidebar, headers, sticky table head
              </p>
            </div>
          </div>
          <div className="relative mt-3 h-32 overflow-hidden rounded-lg bg-gradient-to-tr from-danger/30 via-warn/30 to-accent/40">
            <div className="glass-overlay absolute inset-x-6 inset-y-5 p-3">
              <p className="text-xs font-medium">.glass-overlay</p>
              <p className="text-2xs text-content-secondary">
                context picker, popovers, the YAML copy button
              </p>
            </div>
          </div>
        </Section>

        <Section title="Chips" note="A set of values reads as N things, not one blob.">
          <div className="flex flex-wrap gap-1.5">
            {CHIP_TONES.map((t) => (
              <Chip key={t} tone={t}>
                {t}
              </Chip>
            ))}
          </div>
          <div className="mt-3">
            <ChipList
              values={["control-plane", "master", "etcd"]}
              tone="accent"
            />
          </div>
          <div className="mt-3">
            <Chip mono>krypton.ai/agent=mcp-hello</Chip>
          </div>
        </Section>

        <Section
          title="Status"
          note="Never colour alone — the dot always sits beside its label."
        >
          <div className="flex flex-wrap gap-5 text-sm">
            {DOT_TONES.map((t) => (
              <StatusDot key={t} tone={t} label={t} />
            ))}
          </div>
        </Section>

        <Section
          title="Loading"
          note="Skeletons only on a cold load. A refetch behind existing data gets the quiet dot."
        >
          <div className="mb-3">
            <RefreshingDot />
          </div>
          <div className="overflow-hidden rounded border">
            <SkeletonRows rows={3} columns={4} />
          </div>
          <div className="mt-3 flex gap-2">
            <SkeletonBlock className="h-3 w-40" />
            <SkeletonBlock className="h-3 w-24" />
          </div>
        </Section>

        <Section title="Table" note="Sticky header; rows are focusable only when clickable.">
          <div className="overflow-hidden rounded border">
            <Table
              columns={columns}
              rows={rows}
              rowKey={(r) => r.name}
              onRowClick={() => {}}
            />
          </div>
        </Section>

        <Section
          title="Code"
          note="Its own token ramp, so the pane is legible in both themes."
        >
          <div className="h-64 overflow-hidden rounded border">
            <YamlView source={SAMPLE_YAML} />
          </div>
        </Section>
      </div>
    </div>
  );
}
