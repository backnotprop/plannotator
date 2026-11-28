/**
 * Reviews with nothing to list under a filter, but PRs hidden: its empty line, then the Hidden fold under it, full
 * width. What regresses: the empty line and the fold side by side, squeezed (the empty state's row of children).
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSheet } from '../../ui/scripts/build-inbox-thread-css';

const decls = (selector: string) => {
  const out: Record<string, string> = {};
  parseSheet(readFileSync(resolve(import.meta.dir, '../inbox.css'), 'utf8')).walkRules((rule) => {
    if (rule.parent?.type !== 'root' || !rule.selectors.includes(selector)) return;
    rule.walkDecls((decl) => {
      out[decl.prop] = decl.value;
    });
  });
  return out;
};

test("the empty Reviews list stacks its line over the Hidden fold, and the fold takes the list's width", () => {
  expect(decls('.ib-pr-off')).toMatchObject({ display: 'flex', 'flex-direction': 'column' });
  expect(decls('.ib-pr-off > :not(.ib-pr-empty)')).toMatchObject({ 'align-self': 'stretch' });
});
