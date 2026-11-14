/**
 * Close and reopen a PR are the person's action from the Inbox window only (approval "inbox-pr-board-bulk"). What
 * regresses: an agent tool, an MCP action or a CLI command that reaches them (anything but the window and the route
 * naming the routes or importing the close module), or the review agents losing their `--deny-tool=shell(gh pr close)`.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');
const sources = Bun.spawnSync(['git', 'ls-files', 'packages/*.ts', 'packages/*.tsx', 'packages/*.mjs', 'apps/*.ts', 'apps/*.tsx', 'apps/*.mjs'], { cwd: repoRoot })
  .stdout.toString()
  .split('\n')
  .filter((file) => file && !/\.test\.tsx?$/.test(file));

test('only the window names the close and reopen routes, and only the route runs the close module', () => {
  expect(sources.length).toBeGreaterThan(100);
  const naming = sources.filter((file) => /\/pulls\/(?:close|reopen)\b/.test(readFileSync(join(repoRoot, file), 'utf8')));
  expect(naming.filter((file) => !file.startsWith('packages/inbox/') && file !== 'packages/server/inbox.ts')).toEqual([]);
  const importing = sources.filter((file) => /inbox-pull-close['"]/.test(readFileSync(join(repoRoot, file), 'utf8')));
  expect(importing).toEqual(['packages/server/inbox.ts']);
});

test("the review agents may still not close a PR themselves", () => {
  expect(readFileSync(join(repoRoot, 'packages/server/marker-review.ts'), 'utf8')).toContain('"--deny-tool=shell(gh pr close)"');
});
