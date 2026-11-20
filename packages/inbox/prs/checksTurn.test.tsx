/**
 * Checks running turn, wherever a PR's checks are drawn (ChecksMark: the board's chips, its table, a stack's page, the
 * popover; the PR page's Details ring). What regresses: a running mark that stands still, a passed or failed one that
 * turns, the turn running under reduced motion, or a turn that animates more than a transform (paint on every frame
 * across a board of chips), or one on keyframes the Inbox does not have.
 *
 * The marks are drawn under DOM_TESTS=1 (happy-dom: PullDetails needs a window), from tests/dom-test-list.txt; the
 * stylesheet is read in every run.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseSheet } from '../../ui/scripts/build-inbox-thread-css';
import { ChecksMark } from './ChecksMark';

const hasDom = typeof document !== 'undefined';
const { CheckRows } = (hasDom ? await import('../pulls/PullDetails') : {}) as typeof import('../pulls/PullDetails');

const TURN = 'ib-prck-turn';
const turns = (html: string) => (html.match(new RegExp(`\\b${TURN}\\b`, 'g')) ?? []).length;

test.skipIf(!hasDom)('only the running mark carries the turn: on the board and in the PR page’s Details', () => {
  expect(turns(renderToStaticMarkup(<ChecksMark checks="pending" />))).toBe(1);
  for (const still of ['success', 'failure', null] as const) expect(turns(renderToStaticMarkup(<ChecksMark checks={still} />))).toBe(0);
  const details = (state: 'pass' | 'fail' | 'pending') => renderToStaticMarkup(<CheckRows checks={[{ name: `ci ${state}`, state }]} />);
  expect(turns(details('pending'))).toBe(1);
  expect(turns(details('pass'))).toBe(0);
  expect(turns(details('fail'))).toBe(0);
});

test('the turn is the Inbox’s own keyframes, transform only, and never runs under reduced motion', () => {
  const prs = parseSheet(readFileSync(resolve(import.meta.dir, 'prs.css'), 'utf8'));
  const inbox = readFileSync(resolve(import.meta.dir, '../inbox.css'), 'utf8');
  const animated: { media: string | null; value: string }[] = [];
  prs.walkDecls(/^animation(-name)?$/, (decl) => {
    const rule = decl.parent as { selector?: string; parent?: { type: string; name?: string; params?: string } };
    if (!rule.selector?.includes(TURN)) return;
    const at = rule.parent?.type === 'atrule' ? `@${rule.parent.name} ${rule.parent.params}` : null;
    animated.push({ media: at, value: decl.value });
  });
  expect(animated.length).toBeGreaterThan(0);
  for (const { media, value } of animated) {
    // Only where motion is welcome: with reduced motion the arc rests, as before.
    expect(media).toBe('@media (prefers-reduced-motion: no-preference)');
    const name = value.split(/\s+/)[0]!;
    const frames = inbox.match(new RegExp(`@keyframes ${name} \\{([^}]*\\{[^}]*\\})*[^}]*\\}`));
    expect(frames).not.toBeNull();
    // Transform only: no layout or paint per frame.
    expect(frames![0].replace(/@keyframes [\w-]+/, '')).toMatch(/^\s*\{\s*to \{ transform: rotate\(360deg\); \}\s*\}$/);
  }
});
