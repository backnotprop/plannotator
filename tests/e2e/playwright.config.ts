/**
 * The browser proofs: headless Playwright against the Inbox window, annotate,
 * plan review, code review and the VS Code Guides webview, mostly on the
 * compiled binary under a temp PLANNOTATOR_DATA_DIR. Build the binary first
 * (see inbox.spec.ts), then `bun run test:e2e:inbox`. One spec:
 * `bunx playwright test -c tests/e2e/playwright.config.ts <name>.spec.ts`.
 *
 * Each spec says what it proves in its own header comment. A new
 * `tests/e2e/*.spec.ts` runs in the `chromium` project with no edit to this
 * file; name it `*-webkit.spec.ts` to run it in the `webkit` project only.
 */
import { defineConfig } from '@playwright/test';

/** Specs that their own config runs, never this one: the thread parity harness (inbox-thread-parity.config.ts). */
const OWN_CONFIG = ['inbox-thread-parity.spec.ts'];
/** Specs that run in the `webkit` project only. */
const WEBKIT_ONLY = '*-webkit.spec.ts';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  testIgnore: OWN_CONFIG,
  outputDir: '../../.local/test-results',
  // Feedback never reaches the live Worker, and agent CLI stubs go first on PATH: a stub that is called fails the run (global-setup.ts, agent-cli-stubs.ts).
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 900 },
    launchOptions: { args: ['--use-mock-keychain', '--password-store=basic'] },
  },
  projects: [
    // Every spec but the WebKit-only ones, in Chromium. A project's testIgnore replaces the top-level one, so it repeats OWN_CONFIG.
    { name: 'chromium', testIgnore: [...OWN_CONFIG, WEBKIT_ONLY] },
    // The WebKit-only specs, and the toolstrip's right-to-left check in WebKit too. No Chromium flags here: WebKit refuses them.
    { name: 'webkit', testMatch: [WEBKIT_ONLY, 'toolstrip-rtl.spec.ts', 'inbox-inline-html.spec.ts'], use: { browserName: 'webkit', launchOptions: { args: [] } } },
  ],
});
