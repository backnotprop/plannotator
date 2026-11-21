/**
 * The thread parity harness's Playwright config (scripts/inbox-thread-parity.ts
 * runs it twice: the reference binary writes the PNGs, the candidate binary is
 * compared with them at zero pixels). Not part of `bun run test:e2e:inbox`.
 *
 * Env (set by the script): PLANNOTATOR_PARITY_SEED (the seeded scratch root),
 * PLANNOTATOR_PARITY_OUT (the evidence folder), PLANNOTATOR_PARITY_ROLE
 * (`reference` or `candidate`) and PLANNOTATOR_E2E_BINARY.
 *
 * Projects: desktop 1440 by 900 light and dark, the thread pane at 360 px
 * light and dark and at 320 px (a host's sidebar, for the shared parts'
 * container rules), an iPhone 15 in WebKit light and dark, and a Pixel 7 in
 * Chromium.
 */
import { defineConfig, devices } from '@playwright/test';
import { join, resolve } from 'node:path';

const out = resolve(process.env.PLANNOTATOR_PARITY_OUT ?? join(__dirname, '../../.local/parity/scratch'));
const role = process.env.PLANNOTATOR_PARITY_ROLE === 'reference' ? 'reference' : 'candidate';
/**
 * Chromium flags for repeatable pixels: no GPU, one colour profile, no LCD text, and whole-tile raster
 * (partial raster let an image tile's rounded corners anti-alias differently from run to run).
 */
const CHROMIUM_ARGS = ['--use-mock-keychain', '--password-store=basic', '--font-render-hinting=none', '--disable-gpu', '--force-color-profile=srgb', '--disable-lcd-text', '--disable-partial-raster', '--disable-skia-runtime-opts'];
const desktop = { browserName: 'chromium' as const, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, launchOptions: { args: CHROMIUM_ARGS } };

export default defineConfig({
  testDir: '.',
  // Agent CLI stubs first on PATH; a stub that is called fails the run (agent-cli-stubs.ts).
  globalSetup: './agent-cli-stubs.ts',
  testMatch: ['inbox-thread-parity.spec.ts'],
  outputDir: join(out, role, 'test-results'),
  // Both runs read the reference run's PNGs; only the reference run writes them.
  snapshotPathTemplate: join(out, 'reference', 'png', '{projectName}', '{arg}{ext}'),
  updateSnapshots: role === 'reference' ? 'all' : 'none',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 600_000,
  expect: {
    timeout: 30_000,
    // Zero tolerance: any pixel of any colour counts.
    toHaveScreenshot: { maxDiffPixels: 0, threshold: 0, animations: 'disabled', caret: 'hide', scale: 'device' },
  },
  reporter: [['list'], ['json', { outputFile: join(out, role, 'results.json') }]],
  use: {
    headless: true,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    // A click that cannot happen fails with its reason instead of using up the whole test.
    actionTimeout: 30_000,
  },
  projects: [
    { name: 'desktop-light', use: { ...desktop, colorScheme: 'light' } },
    { name: 'desktop-dark', use: { ...desktop, colorScheme: 'dark' } },
    { name: 'narrow-360', use: { ...desktop, colorScheme: 'light' } },
    { name: 'narrow-360-dark', use: { ...desktop, colorScheme: 'dark' } },
    { name: 'narrow-320', use: { ...desktop, colorScheme: 'light' } },
    { name: 'iphone-15', use: { ...devices['iPhone 15'], browserName: 'webkit', colorScheme: 'light' } },
    { name: 'iphone-15-dark', use: { ...devices['iPhone 15'], browserName: 'webkit', colorScheme: 'dark' } },
    { name: 'pixel-7', use: { ...devices['Pixel 7'], browserName: 'chromium', colorScheme: 'light', launchOptions: { args: CHROMIUM_ARGS } } },
  ],
});
