import { resolve } from 'node:path';
import { formatIssue } from '../format/load.ts';
import { check } from './index.ts';

function usage(message: string): never {
  process.stderr.write(`usage: ${message}\n  check --dir <drawing folder> --root <repo root> [--at <commit>] [--json]\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
let dir: string | undefined;
let root: string | undefined;
let at: string | undefined;
let json = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--json') json = true;
  else if (a === '--dir' || a === '--root' || a === '--at') {
    const v = args[++i];
    if (!v) usage(`${a} needs a value`);
    if (a === '--dir') dir = resolve(v);
    else if (a === '--root') root = resolve(v);
    else at = v;
  } else usage(`unknown argument "${a}"`);
}

if (!dir) usage('--dir <drawing folder> is required');
if (!root) usage('--root <repo root> is required');

let result;
try {
  result = await check({ dir, root, at });
} catch (e) {
  usage(e instanceof Error ? e.message : String(e));
}
const clean = !result.errors.length && !result.warnings.length && !result.missing.length;
if (json) process.stdout.write(JSON.stringify({ ok: clean, ...result }) + '\n');
else {
  for (const e of result.errors) process.stdout.write(`error: ${formatIssue(e)}\n`);
  for (const w of result.warnings) process.stdout.write(`warning: ${formatIssue(w)}\n`);
  for (const m of result.missing) process.stdout.write(`missing: ${m} (cited, not in the repo${at ? ` at ${at}` : ''})\n`);
  if (clean) process.stdout.write(`clean: ${dir}\n`);
}
process.exit(clean ? 0 : 1);
