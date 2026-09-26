import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';
import { Inter, JetBrains_Mono } from 'next/font/google';
import type { Metadata } from 'next';
import { SiteFooter } from '@/components/footer';

// Inter is the app's own UI face. The app uses the system monospace; the
// web has no single one to rely on, so JetBrains Mono stands in for it.
const sans = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-jetbrains',
});

export const metadata: Metadata = {
  metadataBase: new URL('https://loupe.kryptonhq.com'),
  title: {
    default: 'Loupe — a desktop client for Kubernetes',
    template: '%s — Loupe',
  },
  description:
    'Loupe is an open-source desktop client for Kubernetes. It reads the kubeconfig kubectl already uses, talks to the API server directly, and needs nothing installed in the cluster.',
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${mono.variable} font-sans`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">
        <RootProvider>
          {children}
          <SiteFooter />
        </RootProvider>
      </body>
    </html>
  );
}
