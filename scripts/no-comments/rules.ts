import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type KeepReason = 'directive' | 'license' | 'read by a test';

export interface KeepEntry {
  path: string;
  text?: string;
  pattern?: string;
  readBy: string;
}

export const REPO_ROOT = join(import.meta.dir, '..', '..');
export const KEEP_LIST_PATH = 'scripts/strip-comments.keep.json';

export const EXCLUDED_FILES = new Set([
  'packages/system/src/recipe/text.ts',
  'packages/shared/shape/stamp-data.ts',
  'packages/inbox/pulls/githubShortcodes.ts',
]);

const EXCLUDED_FOLDERS = /(^|\/)(node_modules|dist|vendor|generated)\//;

export function isExcludedPath(path: string): boolean {
  return EXCLUDED_FILES.has(path) || EXCLUDED_FOLDERS.test(path);
}

const DIRECTIVE =
  /^(@ts-(expect-error|ignore|nocheck|check)\b|@deprecated\b|@jsx(ImportSource|Runtime|Frag)?\b|[@#]__(PURE|NO_SIDE_EFFECTS)__|@vite-ignore|@refresh reset|[#@] sourceMappingURL=)/;

const TRIPLE_SLASH_DIRECTIVE = /^\/\/\/\s*<(reference|amd-module|amd-dependency)\b/;

const LICENSE = /@license\b|@preserve\b|copyright|SPDX-License-Identifier/i;

function bodyOf(comment: string): string {
  const inner = comment.startsWith('//') ? comment.replace(/^\/\/+/, '') : comment.replace(/^\/\*+!?/, '').replace(/\*\/$/, '');
  return inner.replace(/^[\s*]+/, '');
}

export function isDirective(comment: string): boolean {
  if (TRIPLE_SLASH_DIRECTIVE.test(comment)) return true;
  return DIRECTIVE.test(bodyOf(comment));
}

export function isLicense(comment: string): boolean {
  return comment.startsWith('/*!') || LICENSE.test(comment);
}

export function loadKeepList(root = REPO_ROOT): KeepEntry[] {
  return JSON.parse(readFileSync(join(root, KEEP_LIST_PATH), 'utf8')) as KeepEntry[];
}

export function keptForTest(path: string, comment: string, keepList: KeepEntry[]): KeepEntry | undefined {
  return keepList.find((entry) => {
    const pathMatches = entry.path === '*' || entry.path === path || (entry.path.endsWith('/') && path.startsWith(entry.path));
    if (!pathMatches) return false;
    if (entry.text !== undefined) return comment === entry.text;
    return entry.pattern !== undefined && new RegExp(entry.pattern).test(comment);
  });
}

export function keepReason(path: string, comment: string, keepList: KeepEntry[]): KeepReason | null {
  if (isDirective(comment)) return 'directive';
  if (isLicense(comment)) return 'license';
  if (keptForTest(path, comment, keepList)) return 'read by a test';
  return null;
}
