/**
 * The onboarding tour's entry screen ("Two paths", approval
 * "inbox-onboarding-tour") is what a first run opens on until the tour was
 * started, finished or skipped. Specs about the first-run connect screen
 * itself (or anything a first run shows under it) mark the tour skipped in
 * the scratch config.json before the Inbox starts, so the window opens on
 * that screen as it did before the tour. Never the real data dir.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { refuseRealDataDir } from './real-data-dir';

export function markTourDecided(dataDir: string): void {
  refuseRealDataDir(dataDir, 'markTourDecided');
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, 'config.json');
  const config = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
  config.inboxTour = { version: 1, seen_at: null, finished_at: null, skipped_at: '2026-10-24T00:00:00.000Z', notify_again: false };
  writeFileSync(file, JSON.stringify(config));
}
