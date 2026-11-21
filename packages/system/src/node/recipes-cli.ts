// bun run --cwd packages/system recipes [--check]
// The recipes are written as Markdown in recipe/ so a person and an agent can
// read them there. The browser-safe entry carries them as strings, in
// src/recipe/text.ts, which this script writes from recipe/. With --check it
// only compares, and exits 1 when text.ts is stale.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = join(import.meta.dirname, '..', '..');
const NAMES = { draw: 'DRAW.md', update: 'UPDATE.md', review: 'REVIEW.md', format: 'FORMAT.md' } as const;

export function recipeModule(): string {
  const lines = [
    '// Generated from recipe/*.md by `bun run --cwd packages/system recipes`. Do not edit: edit the Markdown and run it.',
    '',
  ];
  for (const [key, file] of Object.entries(NAMES)) {
    const text = readFileSync(join(pkg, 'recipe', file), 'utf8');
    lines.push(`/** recipe/${file} */`, `export const ${key.toUpperCase()} = ${JSON.stringify(text)};`, '');
  }
  return lines.join('\n');
}

if (import.meta.main) {
  const target = join(pkg, 'src', 'recipe', 'text.ts');
  const want = recipeModule();
  if (process.argv.includes('--check')) {
    const have = readFileSync(target, 'utf8');
    if (have !== want) {
      process.stderr.write('src/recipe/text.ts is stale: run bun run --cwd packages/system recipes\n');
      process.exit(1);
    }
  } else writeFileSync(target, want);
}
