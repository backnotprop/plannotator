/**
 * A fake `cswap` for the Accounts tests: a shell script in a folder of its own,
 * which a test gives the Inbox as its whole PATH. The real claude-swap reads and
 * writes the Keychain item "Claude Code-credentials", so no test may be able
 * to reach one: nothing else goes on that PATH, and the script itself names
 * every program it runs by absolute path. Node-safe (the e2e spec runs under
 * node). POSIX only, like the specs.
 *
 * Each run appends its arguments to `calls.log` in the folder. The answer can
 * change between reads: call `writeFakeCswap` again.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FakeCswapAnswer {
  stdout?: string;
  stderr?: string;
  exit?: number;
  /** Seconds to wait before answering, so reads overlap. */
  delay?: number;
  /** Never answer: it appends to `ticks` every 50 ms until it is killed. */
  hang?: boolean;
}

const quoted = (path: string) => `'${path.replaceAll("'", `'\\''`)}'`;

/** Write (or replace) the fake in `dir`, made if missing. Returns `dir`, the PATH to give the Inbox. */
export function writeFakeCswap(dir: string, answer: FakeCswapAnswer): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stdout'), answer.stdout ?? '');
  writeFileSync(join(dir, 'stderr'), answer.stderr ?? '');
  const file = join(dir, 'cswap');
  writeFileSync(
    file,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> ${quoted(join(dir, 'calls.log'))}`,
      ...(answer.hang ? [`while :; do printf . >> ${quoted(join(dir, 'ticks'))}; /bin/sleep 0.05; done`] : []),
      ...(answer.delay ? [`/bin/sleep ${answer.delay}`] : []),
      `/bin/cat ${quoted(join(dir, 'stdout'))}`,
      `/bin/cat ${quoted(join(dir, 'stderr'))} >&2`,
      `exit ${answer.exit ?? 0}`,
      '',
    ].join('\n'),
  );
  chmodSync(file, 0o755);
  return dir;
}

/** No `cswap` in `dir` any more: not installed. */
export function removeFakeCswap(dir: string): void {
  rmSync(join(dir, 'cswap'), { force: true });
}

/** Each run's arguments, oldest first. */
export function fakeCswapCalls(dir: string): string[] {
  const file = join(dir, 'calls.log');
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

/** How many ticks a hanging fake has made. */
export function fakeCswapTicks(dir: string): number {
  const file = join(dir, 'ticks');
  return existsSync(file) ? readFileSync(file, 'utf8').length : 0;
}
