// Checks that src/pierre-types.ts still matches the semantic-diff types on Pierre's branch.
//
//   node scripts/pierre-drift.ts [<pierre-checkout>] [--no-fetch]
//
// The checkout defaults to ../better-pierre/pierre (or $PIERRE_DIR). The script fetches the branch
// (read-only), reads packages/diffs/src/types.ts from it, and compares every type our copy declares
// with Pierre's, ignoring comments and formatting. It also checks that Pierre's FileDiffMetadata
// still has the fields our engine fills. It exits 1 and lists the differences when they drift.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const BRANCH = 'amadeus/semantic-diffs';
const TYPES = 'packages/diffs/src/types.ts';
/** FileDiffMetadata fields the engine fills, with the type Pierre must give them. */
export const OUTPUT_FIELDS: Record<string, string> = {
  semanticOperations: 'SemanticDiffOperation[]',
  semanticFolds: 'SemanticDiffFold[]',
};

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Formatting-free text: no whitespace, no `export`, no leading `|`, no `;` before `}` or at the end. */
function normalize(decl: string): string {
  return decl
    .replace(/^export\s+/, '')
    .replace(/\s+/g, '')
    .replace(/=\|/g, '=')
    .replace(/;}/g, '}')
    .replace(/;$/, '');
}

/** Every top-level `interface` and `type` declaration, by name, as normalized text. */
export function declarations(src: string): Map<string, string> {
  const text = stripComments(src);
  const out = new Map<string, string>();
  const re = /^(?:export\s+)?(interface|type)\s+(\w+)/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const isInterface = m[1] === 'interface';
    let depth = 0;
    let j = m.index + m[0].length;
    for (; j < text.length; j++) {
      const c = text[j];
      if (c === '{' || c === '(' || c === '[') depth++;
      else if (c === '}' || c === ')' || c === ']') {
        depth--;
        if (isInterface && depth === 0) break;
      } else if (!isInterface && depth === 0 && (c === ';' || (c === '\n' && /^\n\s*(export\s|interface\s|type\s|$)/.test(text.slice(j))))) break;
    }
    out.set(m[2]!, normalize(text.slice(m.index, j + 1)));
  }
  return out;
}

/** The type of `field` inside Pierre's `interface FileDiffMetadata`, normalized, or undefined. */
export function fieldType(theirs: Map<string, string>, iface: string, field: string): string | undefined {
  const body = theirs.get(iface);
  if (!body) return undefined;
  const m = new RegExp(`[{;]${field}\\??:([^;}]+)`).exec(body);
  return m?.[1];
}

/** Human-readable differences between our copy and Pierre's types; empty when they match. */
export function compare(oursSrc: string, theirsSrc: string): string[] {
  const ours = declarations(oursSrc);
  const theirs = declarations(theirsSrc);
  const problems: string[] = [];
  for (const [name, decl] of ours) {
    const t = theirs.get(name);
    if (t === undefined) problems.push(`${name}: Pierre no longer declares it (renamed or removed)`);
    else if (t !== decl) problems.push(`${name} differs\n    ours:   ${decl}\n    Pierre: ${t}`);
    // A type Pierre's version uses that our copy lacks, e.g. a new helper interface.
    for (const ref of new Set((t ?? '').match(/\b(?:Base)?SemanticDiff\w+/g) ?? [])) {
      if (!ours.has(ref) && ref !== name) problems.push(`${name} uses ${ref}, which our copy does not declare`);
    }
  }
  for (const [field, type] of Object.entries(OUTPUT_FIELDS)) {
    const t = fieldType(theirs, 'FileDiffMetadata', field);
    if (t === undefined) problems.push(`FileDiffMetadata has no field ${field} (the engine fills it)`);
    else if (t !== type) problems.push(`FileDiffMetadata.${field} is ${t}, the engine fills ${type}`);
  }
  return [...new Set(problems)];
}

function main(): void {
  const args = process.argv.slice(2);
  const fetch = !args.includes('--no-fetch');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = args.find((a) => !a.startsWith('--')) ?? process.env.PIERRE_DIR ?? path.join(root, '../better-pierre/pierre');
  if (!fs.existsSync(path.join(dir, '.git'))) throw new Error(`no Pierre checkout at ${dir} (pass its path or set PIERRE_DIR)`);
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (fetch) git('fetch', '--quiet', 'origin', `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`);
  const ref = `origin/${BRANCH}`;
  const commit = git('log', '-1', '--format=%h %cs %s', ref).trim();
  const problems = compare(fs.readFileSync(path.join(root, 'src/pierre-types.ts'), 'utf8'), git('show', `${ref}:${TYPES}`));
  if (problems.length === 0) {
    console.log(`src/pierre-types.ts matches ${BRANCH} at ${commit}`);
    return;
  }
  console.log(`src/pierre-types.ts has drifted from ${BRANCH} at ${commit}:\n`);
  for (const p of problems) console.log(`- ${p}`);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
