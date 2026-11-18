/**
 * Every generator of the native app's contract, in order
 * (docs/agent-guides/mobile.md). The one command to regenerate:
 *
 *   bun scripts/mobile/all.ts [--check]
 *
 * Every stale check names this command. The stream suite's generator runs in
 * its own process: it imports the window's stream reader, and no test imports
 * this file, so the contract's main test never reaches the stream reader.
 */
import { GENERATORS } from './generators';
import { REGENERATE, ROOT, emit } from './lib';

const STREAM = 'scripts/mobile/vectors-stream.ts';

if (import.meta.main) {
  const check = process.argv.includes('--check');
  const stale: string[] = [];
  for (const [name, generate] of GENERATORS) {
    const found = emit(await generate(), check);
    stale.push(...found);
    console.log(`${name}: ${check ? (found.length ? 'stale' : 'up to date') : 'written'}`);
  }
  const stream = Bun.spawnSync([process.execPath, STREAM, ...(check ? ['--check'] : [])], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  process.stdout.write(stream.stdout);
  if (stream.exitCode !== 0) stale.push(STREAM.replace('scripts/mobile/', '') + ': ' + stream.stderr.toString().trim().split('\n').slice(1).join(' '));
  if (stale.length) {
    console.error(`stale, run \`${REGENERATE}\` and commit:\n${stale.map((p) => `  ${p}`).join('\n')}`);
    process.exit(1);
  }
}
