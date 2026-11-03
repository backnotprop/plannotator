/**
 * A fake `cswap` for the Accounts tests: a shell script in a folder of its own,
 * which a test gives the Inbox as its whole PATH. The real claude-swap reads and
 * writes the Keychain item "Claude Code-credentials", so no test may be able
 * to reach one: nothing else goes on that PATH, and the script itself names
 * every program it runs by absolute path. Node-safe (the e2e spec runs under
 * node). POSIX only, like the specs.
 *
 * Each run appends its arguments to `calls.log` in the folder. The answer can
 * change between reads: call `writeFakeCswap` again. Its files are replaced by
 * rename, so a run never reads one half-written.
 *
 * `switch` (`cswap switch <n> --json`) answers `FakeCswapSwitch` when one is
 * given, else the same as any run. A switch that exits 0 with `listAfter`
 * makes that the answer of every run after it, as the real tool's list would
 * show the account now in use.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

export interface FakeCswapSwitch extends FakeCswapAnswer {
  /** What every run prints after this switch exits 0. */
  listAfter?: string;
}

const quoted = (path: string) => `'${path.replaceAll("'", `'\\''`)}'`;

/** The whole of `content` appears at `file` at once. */
function replaceFile(file: string, content: string, mode: number) {
  const temp = `${file}.tmp`;
  writeFileSync(temp, content);
  chmodSync(temp, mode);
  renameSync(temp, file);
}

/** One answer's lines, its files named after `name` in `dir`. */
function answerLines(dir: string, name: string, answer: FakeCswapAnswer): string[] {
  replaceFile(join(dir, name), answer.stdout ?? '', 0o644);
  replaceFile(join(dir, `${name}.err`), answer.stderr ?? '', 0o644);
  return [
    ...(answer.hang ? [`while :; do printf . >> ${quoted(join(dir, 'ticks'))}; /bin/sleep 0.05; done`] : []),
    ...(answer.delay ? [`/bin/sleep ${answer.delay}`] : []),
    `/bin/cat ${quoted(join(dir, name))}`,
    `/bin/cat ${quoted(join(dir, `${name}.err`))} >&2`,
  ];
}

/** The lines a switch runs, when the test gave it its own answer. */
function switchLines(dir: string, answer: FakeCswapSwitch): string[] {
  const stdout = join(dir, 'stdout');
  const after = answer.listAfter !== undefined && (answer.exit ?? 0) === 0;
  if (after) replaceFile(join(dir, 'list-after'), answer.listAfter!, 0o644);
  return [
    'if [ "$1" = switch ]; then',
    ...answerLines(dir, 'switch', answer),
    ...(after ? [`/bin/cp ${quoted(join(dir, 'list-after'))} ${quoted(`${stdout}.next`)} && /bin/mv ${quoted(`${stdout}.next`)} ${quoted(stdout)}`] : []),
    `printf . >> ${quoted(join(dir, 'switched'))}`,
    `exit ${answer.exit ?? 0}`,
    'fi',
  ];
}

/** Write (or replace) the fake in `dir`, made if missing. Returns `dir`, the PATH to give the Inbox. */
export function writeFakeCswap(dir: string, answer: FakeCswapAnswer, switchAnswer?: FakeCswapSwitch): string {
  mkdirSync(dir, { recursive: true });
  replaceFile(
    join(dir, 'cswap'),
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> ${quoted(join(dir, 'calls.log'))}`,
      ...(switchAnswer ? switchLines(dir, switchAnswer) : []),
      ...answerLines(dir, 'stdout', answer),
      `printf . >> ${quoted(join(dir, 'finished'))}`,
      `exit ${answer.exit ?? 0}`,
      '',
    ].join('\n'),
    0o755,
  );
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

const count = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').length : 0);

/** How many ticks a hanging fake has made. */
export function fakeCswapTicks(dir: string): number {
  return count(join(dir, 'ticks'));
}

/** How many runs got to the end by themselves (a switch counts in `fakeCswapSwitched`). */
export function fakeCswapFinished(dir: string): number {
  return count(join(dir, 'finished'));
}

/** How many switches got to the end by themselves. */
export function fakeCswapSwitched(dir: string): number {
  return count(join(dir, 'switched'));
}
