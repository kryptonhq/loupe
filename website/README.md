# Loupe documentation site

The site at [loupe.kryptonhq.com](https://loupe.kryptonhq.com): a landing page at `/` and
the documentation under `/docs`, built with [Fumadocs](https://fumadocs.dev) on Next.js.
It is a separate app from Loupe itself — its own `package.json` and lockfile, npm rather
than pnpm — so it deploys and upgrades on its own. It is laid out the same way as
[Arc's](https://github.com/kryptonhq/arc/tree/main/website).

```bash
cd website
npm install
npm run dev     # http://localhost:3000
npm run build   # what Vercel runs
```

A change that only touches `website/` skips the app's CI jobs (see the `changes` job in
`.github/workflows/ci.yml`); `npm run build` locally is the check.

## Where things are

| Path | What it holds |
| --- | --- |
| `content/docs/**.mdx` | The pages. The folder structure is the URL structure |
| `content/docs/**/meta.json` | Section titles, icons, separators and page order |
| `content/docs/releases/` | Release notes, one page per version, mirroring `CHANGELOG.md` |
| `public/img/loupe/` | Screenshots, served as-is |
| `lib/shared.ts` | Site name, and the repository the "Open in GitHub" links point at |
| `lib/layout.shared.tsx` | Navigation bar: wordmark and top-level links |
| `app/(home)/page.tsx` | The landing page |
| `app/global.css` | Loupe's palette and typefaces, matching the app's `src/styles/tokens.css` |
| `components/mdx.tsx` | Components usable in MDX (`Callout`, `Cards`, `Steps`, `Tabs`, `Mermaid`) |
| `components/mermaid.tsx` | Diagram rendering, themed to match the rest of the site |

Adding a page means adding an `.mdx` file with `title` and `description` frontmatter
(and optionally a [Lucide](https://lucide.dev/icons) `icon`), then listing it in the
folder's `meta.json`. Search, `llms.txt`, per-page Markdown and OG images pick it up
automatically.

Keep `⌘` and other symbols out of `description`: it is drawn into the OG image, whose font
has no glyph for them.

## Releasing

Each release gets a page in `content/docs/releases/`, added to that folder's `meta.json`
and to the table in its `index.mdx`. Bump the current version on `installation.mdx` and
`limitations.mdx` at the same time.

## Writing

Diagrams use Mermaid as a component, because Fumadocs does not render
```` ```mermaid ```` blocks on its own:

```mdx
<Mermaid
  chart={`flowchart LR
    Loupe --> API[API server]`}
/>
```

Write links between pages as absolute paths (`/docs/problems`), and plain URLs as Markdown
links: MDX reads `<https://example.com>` as JSX and the build fails. Keyboard shortcuts go
in `<kbd>`.

## Deploying to Vercel

Import the repository and set:

| Setting | Value |
| --- | --- |
| Root directory | `website` |
| Framework preset | Next.js (detected) |
| Build command | `npm run build` (default) |
| Domain | `loupe.kryptonhq.com` |

No environment variables are needed. Point `loupe.kryptonhq.com` at the project with a
`CNAME` to `cname.vercel-dns.com`.
