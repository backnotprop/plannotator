import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');
export const WORKFLOW = '.github/workflows/test.yml';
export const DOM_LIST = 'tests/dom-test-list.txt';

export const DOM_GATE_SELF = new Set([
  'scripts/dom-test-allowlist.test.ts',
  'scripts/ci-test-lanes.test.ts',
  'scripts/test-sandbox.test.ts',
]);

export function isDomGated(source: string): boolean {
  if (/\b(describe|test|it)\.(if|skipIf)\(!?hasDom\)/.test(source)) return true;
  return /DOM_TESTS/.test(source);
}

export function domListFiles(): string[] {
  return readFileSync(join(repoRoot, DOM_LIST), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

export function ownProcessDomStepFiles(): string[] {
  const workflow = readFileSync(join(repoRoot, WORKFLOW), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  return workflow
    .split(/^\s*- name:/m)
    .filter((step) => /DOM_TESTS=1 bun test/.test(step))
    .flatMap((step) => step.match(/[\w./-]+\.test\.tsx?/g) ?? []);
}
