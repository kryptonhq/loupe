import { createGetUrl } from 'fumadocs-core/source';

export const appName = 'Loupe';
export const docsRoute = '/docs';
export const docsImageRoute = '/og/docs';
export const docsContentRoute = '/llms.mdx/docs';

export const gitConfig = {
  user: 'kryptonhq',
  repo: 'loupe',
  branch: 'main',
  // The site lives beside the app, not at the repository root.
  contentDir: 'website/content/docs',
};

export const releasesUrl = 'https://github.com/kryptonhq/loupe/releases/latest';

const getContentUrl = createGetUrl(docsContentRoute);

export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'content.md'];

  return { segments, url: getContentUrl(segments, page.locale) };
}

const getImageUrl = createGetUrl(docsImageRoute);

export function getPageImageUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'image.png'];

  return { segments, url: getImageUrl(segments, page.locale) };
}
