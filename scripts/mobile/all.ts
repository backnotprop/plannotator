/**
 * Every generator of the native app's contract, in order
 * (docs/agent-guides/mobile.md). The one command to regenerate:
 *
 *   bun scripts/mobile/all.ts [--check]
 *
 * Every stale check names this command. The stream suite's generator runs in
 * its own process: it imports the window's stream reader, and no test imports
 * this file, so the contract's main test never reaches the stream reader.
 *
 * A generator that throws is named with its message, and the rest still run;
 * the command then exits 1. A decided ledger row the run leaves naming nothing
 * is listed, so its decision can be moved by hand.
 */
import { REGENERATE, ROOT, emit, readRepoText, OUT } from './lib';
import { emptiedRows, type Ledger } from './parity';

const STREAM = 'scripts/mobile/vectors-stream.ts';
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0]!;

if (import.meta.main) {
  const check = process.argv.includes('--check');
  const stale: string[] = [];
  const failed: string[] = [];
  const before = JSON.parse(readRepoText(OUT.ledger)) as Ledger;
  let generators: Awaited<typeof import('./generators')>['GENERATORS'] = [];
  try {
    generators = (await import('./generators')).GENERATORS;
  } catch (error) {
    failed.push(`loading the generators failed: ${message(error)}`);
  }
  for (const [name, generate] of generators) {
    try {
      const found = emit(await generate(), check);
      stale.push(...found);
      console.log(`${name}: ${check ? (found.length ? 'stale' : 'up to date') : 'written'}`);
    } catch (error) {
      failed.push(`generator ${name} failed: ${message(error)}`);
    }
  }
  const stream = Bun.spawnSync([process.execPath, STREAM, ...(check ? ['--check'] : [])], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  process.stdout.write(stream.stdout);
  if (stream.exitCode !== 0) stale.push(STREAM.replace('scripts/mobile/', '') + ': ' + stream.stderr.toString().trim().split('\n').slice(1).join(' '));
  if (!check) {
    const emptied = emptiedRows(before, JSON.parse(readRepoText(OUT.ledger)) as Ledger);
    if (emptied.length) {
      console.log('Decided ledger rows now naming nothing (move each decision to the entry that replaced it, if any):');
      for (const r of emptied) console.log(`  ${r.id} (${r.mobile}): ${r.surface.join(', ')}`);
    }
  }
  if (failed.length) console.error(`Failed (fix it in scripts/mobile/, in a mobile PR):\n${failed.map((f) => `  ${f}`).join('\n')}`);
  if (stale.length) console.error(`stale, run \`${REGENERATE}\` and commit:\n${stale.map((p) => `  ${p}`).join('\n')}`);
  if (failed.length || stale.length) process.exit(1);
}
