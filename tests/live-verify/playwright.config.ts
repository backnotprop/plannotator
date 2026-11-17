/**
 * The live-behaviour verifier's own Playwright config (scripts/inbox-live-verify.ts runs it). Kept apart from
 * tests/e2e/playwright.config.ts and its `*.spec.ts` glob on purpose: one run takes minutes per store size, so it
 * never joins `bun test`, the e2e shards or the smoke slice. The verifier launches its own Chromium.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.verify.ts',
  workers: 1,
  retries: 0,
  timeout: 0,
  reporter: [['line']],
  outputDir: '../../.local/live-verify/test-results',
});
