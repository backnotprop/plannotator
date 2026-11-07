/**
 * A `bun --preload` for a CLI run from source: the built Inbox page's import
 * gives the path `PLANNOTATOR_TEST_INBOX_PAGE` names, so a test decides whether
 * that page exists and what it holds without touching `apps/hook/dist`.
 */
Bun.plugin({
  name: "redirect-inbox-page",
  setup(build) {
    build.onLoad({ filter: /[\\/]dist[\\/]inbox\.html$/ }, () => ({
      exports: { default: process.env.PLANNOTATOR_TEST_INBOX_PAGE },
      loader: "object",
    }));
  },
});
