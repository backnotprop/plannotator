/**
 * The Draft line's Discard is disabled while a Send is out (DraftStamp's `disabled`), and it must look it: dimmed,
 * the default cursor, no hover change, as the Inbox's other disabled text buttons look. What regressed: the held
 * button kept full colour, the pointer and its hover underline, so it looked pressable and did nothing.
 * The look itself is in the PR's pictures; a DOM test cannot read a stylesheet's cascade, so this reads the sheet.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSheet } from '../../ui/scripts/build-inbox-thread-css';

const sheet = parseSheet(readFileSync(resolve(import.meta.dir, '../inbox.css'), 'utf8'));

const decls = (selector: string) => {
  const out: Record<string, string> = {};
  sheet.walkRules((rule) => {
    if (rule.parent?.type !== 'root' || !rule.selectors.includes(selector)) return;
    rule.walkDecls((decl) => {
      out[decl.prop] = decl.value;
    });
  });
  return out;
};

test('a disabled Discard is dimmed, with the default cursor', () => {
  const held = decls('.ib-draft-discard:disabled');
  expect(Number(held.opacity)).toBeGreaterThan(0);
  expect(Number(held.opacity)).toBeLessThan(1);
  expect(held.cursor).toBe('default');
});

test("a disabled Discard has no hover change: every hover rule on it skips a disabled one", () => {
  const hovers: string[] = [];
  sheet.walkRules((rule) => {
    for (const selector of rule.selectors) if (/\.ib-draft-discard(?::[\w-]+(?:\([^)]*\))?)*:hover/.test(selector)) hovers.push(selector);
  });
  expect(hovers.length).toBeGreaterThan(0);
  expect(hovers.filter((selector) => !selector.includes(':not(:disabled)'))).toEqual([]);
});
