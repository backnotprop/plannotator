import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { changedSourceFiles, isInScope, trackedSourceFiles, writeBaseline } from './no-comments/files.ts';
import { loadKeepList, REPO_ROOT } from './no-comments/rules.ts';
import { scanRepo } from './no-comments/guard.ts';
import { stripSource } from './no-comments/strip-source.ts';

const USAGE = `usage: bun scripts/strip-comments.ts <file...> | --all | --changed <base> | --write-baseline

Removes every comment from .ts .tsx .mts .cts .js .mjs .cjs .jsx files, except tool directives,
license notices and the comments listed in scripts/strip-comments.keep.json. Code is left as it is.

  <file...>          strip these files
  --all              strip every tracked source file
  --changed <base>   strip the source files changed since the merge base with <base> (committed or not)
  --write-baseline   write tests/no-comments.baseline.txt: every tracked file that still has comments`;

function repoPath(path: string): string {
  return isAbsolute(path) ? relative(REPO_ROOT, path) : relative(REPO_ROOT, join(process.cwd(), path));
}

function filesFromArgs(args: string[]): string[] | null {
  if (args[0] === '--all' && args.length === 1) return trackedSourceFiles();
  if (args[0] === '--changed' && args.length === 2) return changedSourceFiles(args[1]!);
  if (args.length > 0 && args.every((arg) => !arg.startsWith('--'))) return args.map(repoPath);
  return null;
}

function writeBaselineFile(): void {
  const { counts } = scanRepo(trackedSourceFiles(), loadKeepList());
  writeBaseline(counts);
  const listed = [...counts.values()].filter((count) => count > 0).length;
  console.log(`tests/no-comments.baseline.txt: ${listed} files still have comments.`);
}

function stripFiles(paths: string[]): number {
  const keepList = loadKeepList();
  let failures = 0;
  let removed = 0;
  let changed = 0;
  for (const path of paths) {
    if (!isInScope(path)) {
      console.log(`${path}: skipped (not a source file this tool covers, or excluded)`);
      continue;
    }
    const absolute = join(REPO_ROOT, path);
    const text = readFileSync(absolute, 'utf8');
    const result = stripSource(path, text, keepList);
    if (!result.ok) {
      failures++;
      console.error(`${path}: ${result.reason}`);
      continue;
    }
    if (result.text === text) continue;
    writeFileSync(absolute, result.text);
    changed++;
    removed += result.removed;
  }
  console.log(`Removed ${removed} comments from ${changed} files.`);
  return failures;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--write-baseline') {
    writeBaselineFile();
    process.exit(0);
  }
  const files = filesFromArgs(args);
  if (!files) {
    console.error(USAGE);
    process.exit(2);
  }
  process.exit(stripFiles(files) > 0 ? 1 : 0);
}
