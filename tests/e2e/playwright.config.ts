/**
 * The Inbox window's browser proofs: a real Chromium against the compiled
 * binary (`plannotator inbox`), under a temp PLANNOTATOR_DATA_DIR: the window
 * (inbox.spec.ts), notifications, decisions (inbox-decisions.spec.ts) and
 * guided reviews (inbox-guides.spec.ts) and New message
 * (inbox-new-message.spec.ts). Build the binary first (see
 * inbox.spec.ts), then `bun run test:e2e:inbox`.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['inbox.spec.ts', 'notifications.spec.ts', 'inbox-decisions.spec.ts', 'inbox-attachments.spec.ts', 'inbox-guides.spec.ts', 'inbox-new-message.spec.ts'],
  outputDir: '../../.local/test-results',
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
});
