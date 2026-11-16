import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASELINE_PATH, readBaseline, trackedSourceFiles } from './files.ts';
import { planComments } from './plan.ts';
import { type KeepEntry, KEEP_LIST_PATH, keptForTest, loadKeepList, REPO_ROOT } from './rules.ts';

export function baselineProblems(counts: Map<string, number>, baseline: Map<string, number>): string[] {
  const problems: string[] = [];
  for (const [path, count] of counts) {
    const allowed = baseline.get(path);
    if (allowed === undefined && count > 0) {
      problems.push(`${path} has ${count} comment(s). Code comments are not allowed: run \`bun scripts/strip-comments.ts ${path}\`.`);
    } else if (allowed !== undefined && count === 0) {
      problems.push(`${path} has no comments left: delete its line from ${BASELINE_PATH}.`);
    } else if (allowed !== undefined && count > allowed) {
      problems.push(`${path} gained comments (${count}, the baseline allows ${allowed}): run \`bun scripts/strip-comments.ts ${path}\` and delete its line from ${BASELINE_PATH}.`);
    }
  }
  for (const path of baseline.keys()) {
    if (!counts.has(path)) problems.push(`${path} is in ${BASELINE_PATH} but is no longer a tracked source file: delete its line.`);
  }
  return problems;
}

export interface RepoScan {
  counts: Map<string, number>;
  usedKeepEntries: Set<KeepEntry>;
}

export function scanRepo(paths: string[], keepList: KeepEntry[], root = REPO_ROOT): RepoScan {
  const counts = new Map<string, number>();
  const usedKeepEntries = new Set<KeepEntry>();
  for (const path of paths) {
    const plan = planComments(path, readFileSync(join(root, path), 'utf8'), keepList);
    counts.set(path, plan.remove.length);
    for (const { site } of plan.keep) {
      for (const comment of site.comments) {
        const entry = keptForTest(path, comment.text, keepList);
        if (entry) usedKeepEntries.add(entry);
      }
    }
  }
  return { counts, usedKeepEntries };
}

export function repoCommentProblems(root = REPO_ROOT): string[] {
  const keepList = loadKeepList(root);
  const { counts, usedKeepEntries } = scanRepo(trackedSourceFiles(root), keepList, root);
  const problems = baselineProblems(counts, readBaseline(root));
  for (const entry of keepList.filter((candidate) => candidate.path !== '*' && !usedKeepEntries.has(candidate))) {
    problems.push(`${KEEP_LIST_PATH} keeps ${JSON.stringify(entry.text ?? entry.pattern)} in ${entry.path}, but no comment matches it any more: delete the entry.`);
  }
  return problems;
}
