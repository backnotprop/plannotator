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
