import { defineConfig, devices } from '@playwright/test';
import { join, resolve } from 'node:path';

const out = resolve(process.env.PLANNOTATOR_PARITY_OUT ?? join(__dirname, '../../.local/parity/scratch'));
const role = process.env.PLANNOTATOR_PARITY_ROLE === 'reference' ? 'reference' : 'candidate';
const CHROMIUM_ARGS = ['--use-mock-keychain', '--password-store=basic', '--font-render-hinting=none', '--disable-gpu', '--force-color-profile=srgb', '--disable-lcd-text', '--disable-partial-raster', '--disable-skia-runtime-opts'];
const desktop = { browserName: 'chromium' as const, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, launchOptions: { args: CHROMIUM_ARGS } };

export default defineConfig({
  testDir: '.',
  globalSetup: './agent-cli-stubs.ts',
  testMatch: ['inbox-thread-parity.spec.ts'],
  outputDir: join(out, role, 'test-results'),
  snapshotPathTemplate: join(out, 'reference', 'png', '{projectName}', '{arg}{ext}'),
  updateSnapshots: role === 'reference' ? 'all' : 'none',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 600_000,
  expect: {
    timeout: 30_000,
    toHaveScreenshot: { maxDiffPixels: 0, threshold: 0, animations: 'disabled', caret: 'hide', scale: 'device' },
  },
  reporter: [['list'], ['json', { outputFile: join(out, role, 'results.json') }]],
  use: {
    headless: true,
    locale: 'en-US',
    timezoneId: 'America/New_York',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
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
