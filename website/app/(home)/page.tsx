import Image from 'next/image';
import Link from 'next/link';
import { releasesUrl } from '@/lib/shared';

const platforms = [
  { name: 'macOS', note: 'signed and notarised, Apple Silicon and Intel' },
  { name: 'Linux', note: '.deb, .rpm and .AppImage, each GPG-signed' },
  { name: 'Windows', note: 'MSI and NSIS installers' },
];

export default function HomePage() {
  return (
    <main className="flex flex-1 flex-col">
      <section className="mx-auto w-full max-w-5xl px-6 pb-14 pt-20">
        <p className="inline-flex items-center gap-2 rounded-full border border-fd-border px-3 py-1 text-xs text-fd-muted-foreground">
          <span className="size-1.5 rounded-full bg-[var(--color-loupe-indigo)]" />
          Open source, Apache-2.0
        </p>

        <h1 className="mt-6 max-w-3xl text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
          A desktop client for any Kubernetes cluster.
        </h1>

        <p className="mt-5 max-w-2xl text-lg text-fd-muted-foreground">
          Loupe reads the kubeconfig <code className="font-mono text-base">kubectl</code>{' '}
          already uses and talks to the API server from your machine. Nothing is installed in the
          cluster, nothing is sent anywhere, and it sees exactly what your RBAC lets you see.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link
            href="/docs/installation"
            className="rounded-md bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground transition-colors hover:opacity-90"
          >
            Install Loupe
          </Link>
          <Link
            href="/docs"
            className="rounded-md border border-fd-border px-4 py-2 text-sm font-medium transition-colors hover:bg-fd-accent"
          >
            Read the docs
          </Link>
          <a
            href={releasesUrl}
            className="px-2 py-2 text-sm font-medium text-fd-muted-foreground transition-colors hover:text-fd-foreground"
          >
            All downloads
          </a>
        </div>

        <pre className="mt-10 w-fit max-w-full overflow-x-auto rounded-lg border border-fd-border bg-fd-card px-4 py-3 font-mono text-sm">
          <code>brew install --cask kryptonhq/tap/loupe</code>
        </pre>
      </section>

      <section className="mx-auto w-full max-w-5xl px-6 pb-16">
        <Image
          src="/img/loupe/tabs.png"
          alt="Loupe with two tabs open, a pod listing and the breadcrumb showing where a pod sits"
          width={1340}
          height={860}
          priority
          className="w-full rounded-xl border border-fd-border shadow-xl shadow-black/5"
        />
      </section>

      <section className="border-t border-fd-border bg-fd-card/40">
        <div className="mx-auto grid w-full max-w-5xl gap-px overflow-hidden px-6 py-12 sm:grid-cols-3">
          <Feature
            title="What kubectl get would print"
            body="Lists come from the API server's own table endpoint, so every kind — custom resources included — shows the columns its authors chose."
          />
          <Feature
            title="What's broken, at a glance"
            body="A dashboard and a Problems view kept current by watches: crash loops, unschedulable pods, pressured nodes, failed jobs."
          />
          <Feature
            title="Writes you meant to make"
            body="A diff before every apply, conflicts refused rather than overwritten, and contexts that can be marked protected or read-only."
          />
        </div>
      </section>

      <section className="mx-auto w-full max-w-5xl px-6 py-14">
        <h2 className="text-lg font-semibold tracking-tight">Runs where you do</h2>
        <p className="mt-1 text-sm text-fd-muted-foreground">
          A native app on each platform, updating itself from a signed feed.
        </p>
        <ul className="mt-5 divide-y divide-fd-border border-y border-fd-border">
          {platforms.map((platform) => (
            <li key={platform.name} className="flex flex-wrap items-baseline gap-x-4 py-2.5">
              <span className="w-20 text-sm font-medium">{platform.name}</span>
              <span className="text-sm text-fd-muted-foreground">{platform.note}</span>
            </li>
          ))}
        </ul>
        <Link
          href="/docs/installation"
          className="mt-5 inline-block text-sm font-medium text-fd-primary hover:underline"
        >
          Installation and verifying a download
        </Link>
      </section>
    </main>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-1 py-4 sm:px-6 sm:py-0">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-1.5 text-sm text-fd-muted-foreground">{body}</p>
    </div>
  );
}
