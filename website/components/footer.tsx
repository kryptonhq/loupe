import Link from 'next/link';
import { releasesUrl } from '@/lib/shared';

export function SiteFooter() {
  return (
    <footer className="border-t border-fd-border px-6 py-5 text-sm text-fd-muted-foreground">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
        <p>
          Crafted by{' '}
          <a
            href="https://www.varunk.me/"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-fd-foreground hover:text-fd-primary"
          >
            Varun
          </a>{' '}
          with Claude
        </p>
        <nav className="flex items-center gap-4">
          <Link href="/docs" className="hover:text-fd-foreground">
            Docs
          </Link>
          <a
            href="https://github.com/kryptonhq/loupe"
            className="hover:text-fd-foreground"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
          <a href={releasesUrl} className="hover:text-fd-foreground" target="_blank" rel="noreferrer">
            Download
          </a>
          <a href="https://www.kryptonhq.com/" className="hover:text-fd-foreground">
            Krypton
          </a>
          <span>Apache-2.0</span>
        </nav>
      </div>
    </footer>
  );
}
