/**
 * Runs the quarantined browser tests locally (tests/e2e/quarantine.json):
 * CI leaves them out, so this is where a fix is proved.
 *
 *   bun run test:e2e:quarantine                  # every spec that holds one
 *   bun run test:e2e:quarantine --repeat-each 5  # extra args go to Playwright
 *
 * It runs each such spec whole, in its file's order: the specs are serial and
 * share one Inbox, so a test alone would miss the state the tests before it
 * leave. `CI` is dropped from the env, so nothing is left out. Build the binary
 * first, as for `bun run test:e2e:inbox` (see tests/e2e/inbox.spec.ts). The
 * specs sandbox themselves (temp data dir and HOME, no browser opened).
 */
import { resolve } from 'node:path';
import { quarantineEntries } from '../tests/e2e/quarantine';

const repoRoot = resolve(import.meta.dir, '..');
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

if (import.meta.main) {
  const specs = [...new Set(quarantineEntries().map((entry) => entry.spec))].sort();
  if (!specs.length) {
    console.log('No quarantined tests (tests/e2e/quarantine.json is empty).');
    process.exit(0);
  }
  console.log(`Quarantined specs, run whole:\n  ${specs.join('\n  ')}`);
  const { CI: _ci, ...env } = process.env;
  const child = Bun.spawnSync(['bunx', 'playwright', 'test', '-c', 'tests/e2e/playwright.config.ts', ...specs.map((spec) => `tests/e2e/${escape(spec)}$`), ...process.argv.slice(2)], {
    cwd: repoRoot,
    env,
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  process.exit(child.exitCode ?? 1);
}
