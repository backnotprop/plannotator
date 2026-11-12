import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSourcePath } from './find-comments.ts';
import { isExcludedPath, REPO_ROOT } from './rules.ts';

export const BASELINE_PATH = 'tests/no-comments.baseline.txt';

function git(args: string[], root: string): string {
  const run = Bun.spawnSync(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString().trim()}`);
  return run.stdout.toString();
}

export function isInScope(path: string): boolean {
  return isSourcePath(path) && !isExcludedPath(path);
}

export function trackedSourceFiles(root = REPO_ROOT): string[] {
  return git(['ls-files', '-z'], root).split('\0').filter(Boolean).filter(isInScope);
}

export function changedSourceFiles(base: string, root = REPO_ROOT): string[] {
  const mergeBase = git(['merge-base', base, 'HEAD'], root).trim();
  const changed = git(['diff', '--name-only', '-z', '--diff-filter=ACMR', mergeBase], root).split('\0').filter(Boolean);
  return changed.filter(isInScope);
}

export function readBaseline(root = REPO_ROOT): Map<string, number> {
  const baseline = new Map<string, number>();
  for (const line of readFileSync(join(root, BASELINE_PATH), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const [count, path] = line.split('\t');
    baseline.set(path!, Number(count));
  }
  return baseline;
}

export function writeBaseline(counts: Map<string, number>, root = REPO_ROOT): void {
  const lines = [...counts].filter(([, count]) => count > 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, count]) => `${count}\t${path}`);
  writeFileSync(join(root, BASELINE_PATH), lines.length ? `${lines.join('\n')}\n` : '');
}
