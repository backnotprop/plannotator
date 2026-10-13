import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { cp } from 'node:fs/promises';
import { INBOX_LAUNCHED, INBOX_POST_ID } from './src/lib/inbox-launch.ts';

const indexableBlogPages = new Set([
  'https://plannotator.ai/blog/',
  'https://plannotator.ai/blog/an-interactive-ui-for-the-grill-me-skill/',
  ...(INBOX_LAUNCHED ? [`https://plannotator.ai/blog/${INBOX_POST_ID}/`] : []),
]);

// The Inbox screens and OG image live outside public/ so the deployed site
// ships none of them until launch (src/lib/inbox-launch.ts).
const inboxAssets = {
  name: 'inbox-assets',
  hooks: {
    'astro:build:done': async ({ dir }) => {
      if (!INBOX_LAUNCHED) return;
      await cp(new URL('./inbox-assets/', import.meta.url), new URL('assets/inbox/', dir), { recursive: true });
    },
  },
};

export default defineConfig({
  site: 'https://plannotator.ai',
  output: 'static',
  // Preserve Astro 5's HTML-aware whitespace handling. Astro 7 otherwise
  // defaults to JSX whitespace rules, which can remove spaces between inline
  // elements and cause subtle copy/layout regressions across the static site.
  compressHTML: true,
  integrations: [
    inboxAssets,
    react(),
    sitemap({
      filter: (page) =>
        !page.startsWith('https://plannotator.ai/docs/') &&
        (!page.startsWith('https://plannotator.ai/blog/') ||
          indexableBlogPages.has(page)),
    }),
  ],
  markdown: {
    shikiConfig: {
      themes: {
        light: 'github-light',
        dark: 'github-dark',
      },
    },
  },
  vite: {
    plugins: [tailwindcss()],
  },
  build: {
    format: 'directory',
  },
  trailingSlash: 'always',
});
