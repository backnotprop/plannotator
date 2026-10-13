/**
 * The Inbox window's browser proofs: a real Chromium against the compiled
 * binary (`plannotator inbox`), under a temp PLANNOTATOR_DATA_DIR: the window
 * (inbox.spec.ts), notifications, decisions (inbox-decisions.spec.ts) and
 * guided reviews (inbox-guides.spec.ts), New message
 * (inbox-new-message.spec.ts), the question sound and its one-time dialog (inbox-sound.spec.ts), stepping through a thread's attachments (inbox-attachment-stepping.spec.ts), replying when the asking session has ended (inbox-ended-session.spec.ts), the order inside a section (inbox-order.spec.ts), replaced questions (inbox-replaced.spec.ts), folding a thread (inbox-thread-folding.spec.ts), phones (inbox-phones.spec.ts), the sidebar (inbox-sidebar.spec.ts), the list column's resize edge (inbox-list-resize.spec.ts), images in messages (inbox-message-images.spec.ts), links to attached files (inbox-message-links.spec.ts), Over your tailnet (inbox-tailscale.spec.ts), the update control (inbox-updates.spec.ts), Mark read and the Send that skips (inbox-mark-read.spec.ts), archived threads in Settings (inbox-archived.spec.ts), the row you open staying put and the settle (inbox-open-stays-put.spec.ts), a new message in the thread you have open (inbox-seen-on-sight.spec.ts), the agents on this computer (inbox-agents.spec.ts), the annotation toolstrip painting above the document in the Inbox and annotate (toolstrip-stacking.spec.ts), the window on a phone in WebKit and Chromium (inbox-mobile.spec.ts), Settings in sections (inbox-settings.spec.ts), and the
 * surface a phone hosts, in WebKit (surface.spec.ts). Build the binary
 * first (see inbox.spec.ts), then `bun run test:e2e:inbox`.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['inbox.spec.ts', 'notifications.spec.ts', 'inbox-decisions.spec.ts', 'inbox-attachments.spec.ts', 'inbox-attachments-kinds.spec.ts', 'inbox-attachment-stepping.spec.ts', 'inbox-guides.spec.ts', 'inbox-new-message.spec.ts', 'inbox-ended-session.spec.ts', 'inbox-order.spec.ts', 'inbox-replaced.spec.ts', 'inbox-thread-folding.spec.ts', 'inbox-phones.spec.ts', 'inbox-sidebar.spec.ts', 'inbox-list-resize.spec.ts', 'inbox-message-images.spec.ts', 'inbox-message-links.spec.ts', 'inbox-tailscale.spec.ts', 'inbox-updates.spec.ts', 'inbox-sound.spec.ts', 'inbox-mark-read.spec.ts', 'inbox-archived.spec.ts', 'inbox-open-stays-put.spec.ts', 'inbox-seen-on-sight.spec.ts', 'inbox-mobile.spec.ts', 'toolstrip-stacking.spec.ts', 'inbox-agents.spec.ts', 'inbox-settings.spec.ts', 'surface.spec.ts'],
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
