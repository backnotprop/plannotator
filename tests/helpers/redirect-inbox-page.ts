Bun.plugin({
  name: "redirect-inbox-page",
  setup(build) {
    build.onLoad({ filter: /[\\/]dist[\\/]inbox\.html$/ }, () => ({
      exports: { default: process.env.PLANNOTATOR_TEST_INBOX_PAGE },
      loader: "object",
    }));
  },
});
