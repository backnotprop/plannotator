/**
 * What every generator of the native app's contract shares (apps/mobile/contract,
 * docs/agent-guides/mobile.md): the paths it writes, deterministic JSON, and
 * the write-or-check step.
 *
 * Every output path is a literal here. Never list a folder of the checkout
 * from a generator. This module imports no product code, so a test may import
 * it (its emit, on a temp folder) and still never fail for an Inbox change;
 * scripts/ci-affected-map.test.ts holds that.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dir, '../..');

/** Every file a generator writes, relative to the repository. */
export const OUT = {
  door: 'apps/mobile/contract/door.json',
  schema: 'apps/mobile/contract/schema/wire.schema.json',
  swift: 'apps/mobile/contract/generated/swift/Wire.swift',
  required: 'apps/mobile/contract/schema/required.json',
  tokens: 'apps/mobile/contract/tokens/tokens.json',
  catalog: 'apps/mobile/contract/generated/swift/Tokens.xcassets/Contents.json',
  words: 'apps/mobile/contract/words/words.json',
  wordsSwift: 'apps/mobile/contract/generated/swift/Words.swift',
  surface: 'apps/mobile/contract/parity/surface.json',
  ledger: 'apps/mobile/contract/parity/ledger.json',
} as const;

/** Where door.ts writes the contract's number (contractVersion in door.ts). */
export const VERSION_FILE = 'apps/mobile/contract/VERSION';

/** Write a repository file, by its path from the root (always a path named as a literal by the caller). */
export function writeRepoText(path: string, text: string): void {
  writeFileSync(join(ROOT, path), text);
}

/** Whether a repository file exists, by its path from the root (always a path named as a literal by the caller). */
export function repoFileExists(path: string): boolean {
  return existsSync(join(ROOT, path));
}

/** A repository file's text, by its path from the root (always a path named as a literal by the caller). */
export function readRepoText(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

export type Output = { path: string; text: string };

/** The one command that brings every generated contract file up to date (scripts/mobile/all.ts). */
export const REGENERATE = 'bun scripts/mobile/all.ts';

/** JSON with two-space indents and a final newline: the same value always gives the same bytes. */
export function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Write the outputs, or with `check` compare them with the committed files
 * and return the stale ones (a missing file is stale). `root`: the checkout
 * (a test passes a temp folder).
 */
export function emit(outputs: Output[], check: boolean, root = ROOT): string[] {
  const stale: string[] = [];
  for (const output of outputs) {
    const file = join(root, output.path);
    const now = existsSync(file) ? readFileSync(file, 'utf8') : null;
    if (now === output.text) continue;
    if (check) stale.push(output.path);
    else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, output.text);
    }
  }
  return stale;
}

/** A generator's command line: `bun scripts/mobile/<name>.ts [--check]`. A generator may be async. */
export async function cli(name: string, generate: () => Output[] | Promise<Output[]>): Promise<void> {
  const check = process.argv.includes('--check');
  const outputs = await generate();
  const stale = emit(outputs, check);
  if (check && stale.length) {
    console.error(`${name}: stale, run \`${REGENERATE}\` and commit:\n${stale.map((p) => `  ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`${name}: ${check ? 'up to date' : 'wrote'} ${outputs.map((o) => o.path).join(', ')}`);
}
