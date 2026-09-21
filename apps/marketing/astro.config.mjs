import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

const indexableBlogPages = new Set([
  'https://plannotator.ai/blog/',
  'https://plannotator.ai/blog/an-interactive-ui-for-the-grill-me-skill/',
]);

export default defineConfig({
  site: 'https://plannotator.ai',
  output: 'static',
  // Preserve Astro 5's HTML-aware whitespace handling. Astro 7 otherwise
  // defaults to JSX whitespace rules, which can remove spaces between inline
  // elements and cause subtle copy/layout regressions across the static site.
  compressHTML: true,
  integrations: [
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
