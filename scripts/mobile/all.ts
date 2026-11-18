/**
 * Every generator of the native app's contract, in the order each reads the
 * one before (docs/agent-guides/mobile.md). The one command to regenerate:
 *
 *   bun scripts/mobile/all.ts [--check]
 *
 * Every stale check names this command.
 */
import { generateDoor } from './door';
import { REGENERATE, emit, type Output } from './lib';
import { generateSchema } from './schema';
import { generateSwift } from './swift';
import { generateTokens } from './tokens';
import { generateWords } from './words';

/** In order: swift reads the schema and door.json as written. */
export const GENERATORS: readonly (readonly [string, () => Output[] | Promise<Output[]>])[] = [
  ['door', generateDoor],
  ['schema', generateSchema],
  ['swift', generateSwift],
  ['tokens', generateTokens],
  ['words', generateWords],
];

if (import.meta.main) {
  const check = process.argv.includes('--check');
  const stale: string[] = [];
  for (const [name, generate] of GENERATORS) {
    const found = emit(await generate(), check);
    stale.push(...found);
    console.log(`${name}: ${check ? (found.length ? 'stale' : 'up to date') : 'written'}`);
  }
  if (stale.length) {
    console.error(`stale, run \`${REGENERATE}\` and commit:\n${stale.map((p) => `  ${p}`).join('\n')}`);
    process.exit(1);
  }
}
