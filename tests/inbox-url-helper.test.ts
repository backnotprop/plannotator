import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { inboxUrl } from '../packages/inbox/inboxUrl';

// Every Inbox server URL the window builds goes through `inboxUrl`
// (packages/inbox/inboxUrl.ts), so routing another machine's threads later
// changes one file. A raw `/api/inbox` string anywhere else in the window's
// source is the regression this guards. Comments may still name routes.

const root = resolve(import.meta.dir, '..');
const WINDOW = join(root, 'packages/inbox');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== 'inboxUrl.ts') out.push(path);
  }
  return out;
}

/** Drop block comments and `//` line comments (a `//` after a quote or colon, as in `https://`, is not one). */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

describe('the Inbox window writes server URLs through inboxUrl', () => {
  test('no raw /api/inbox string outside the helper and tests', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(WINDOW)) {
      withoutComments(readFileSync(file, 'utf8')).split('\n').forEach((line, index) => {
        if (line.includes('/api/inbox')) offenders.push(`${relative(root, file)}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  test('builds the path under /api/inbox, with an optional query', () => {
    expect(inboxUrl('/threads/msg_1')).toBe('/api/inbox/threads/msg_1');
    expect(inboxUrl('/search', 'q=a%20b')).toBe('/api/inbox/search?q=a%20b');
    expect(inboxUrl('/threads/archived', '')).toBe('/api/inbox/threads/archived');
  });
});
