// bun run --cwd packages/system check [--dir <drawing>] [--root <repo>] [--json]
// Loads a drawing and checks that every path it cites exists in the repo.
// Exit 0 clean, 1 not clean, 2 bad usage.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { check, DRAWING_DIR } from './index.ts';

function usage(message: string): never {
  process.stderr.write(`usage: ${message}\n  check [--dir <drawing folder>] [--root <repo root>] [--json]\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
let dir: string | undefined;
let root: string | undefined;
let json = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--json') json = true;
  else if (a === '--dir' || a === '--root') {
    const v = args[++i];
    if (!v) usage(`${a} needs a path`);
    if (a === '--dir') dir = resolve(v);
    else root = resolve(v);
  } else usage(`unknown argument "${a}"`);
}

// with no --root, the nearest folder up from here that holds a drawing
if (!root) {
  for (let d = resolve(dir ? join(dir, '..', '..') : process.cwd()); ; d = dirname(d)) {
    if (existsSync(join(d, DRAWING_DIR, 'system.yaml'))) {
      root = d;
      break;
    }
    if (dirname(d) === d) usage('no .plannotator/system found here or above; pass --root');
  }
}
dir ??= join(root, DRAWING_DIR);

const result = await check({ dir, root });
const clean = !result.errors.length && !result.warnings.length && !result.missing.length;
if (json) process.stdout.write(JSON.stringify({ ok: clean, ...result }) + '\n');
else {
  for (const e of result.errors) process.stdout.write(`error: ${e}\n`);
  for (const w of result.warnings) process.stdout.write(`warning: ${w}\n`);
  for (const m of result.missing) process.stdout.write(`missing: ${m} (cited, not in ${root})\n`);
  if (clean) process.stdout.write(`clean: ${dir}\n`);
}
process.exit(clean ? 0 : 1);
