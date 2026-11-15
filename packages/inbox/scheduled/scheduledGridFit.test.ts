/**
 * A bare `1fr` grid track grows to its longest content, so a long folder path or name pushed the editor past a
 * 390-wide pane. Every flexible track in the scheduled sheet sets its own minimum (`minmax(0, 1fr)`).
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSheet } from '../../ui/scripts/build-inbox-thread-css';

test('no grid track in scheduled.css is a bare fr that a long path can widen', () => {
  const bare: string[] = [];
  parseSheet(readFileSync(resolve(import.meta.dir, 'scheduled.css'), 'utf8')).walkDecls('grid-template-columns', (decl) => {
    const outside = decl.value.replace(/minmax\([^)]*\)/g, '');
    if (/\bfr\b|\dfr/.test(outside)) bare.push(`${(decl.parent as { selector?: string }).selector}: ${decl.value}`);
  });
  expect(bare).toEqual([]);
});
