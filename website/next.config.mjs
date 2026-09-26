import { createMDX } from 'fumadocs-mdx/next';
import { fileURLToPath } from 'node:url';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // The site sits inside the Loupe repository, whose own pnpm lockfile
  // would otherwise be taken as the workspace root.
  turbopack: {
    root: fileURLToPath(new URL('.', import.meta.url)),
  },
};

export default withMDX(config);
