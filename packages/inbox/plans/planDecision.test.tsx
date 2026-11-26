/**
 * The plan page's decision mark (PlanDecision.tsx) and its menu's rows (PlanChrome.tsx), drawn alone. What regresses
 * if these fail:
 * - the decision's card stops opening on a press, loses what the bar's sentence said (the decision, its version and
 *   when, the moved notice and its Dismiss), is drawn outside the Inbox's root, is not announced from its mark, or
 *   stays open after Escape or a second press;
 * - a phone's menu row acts with the handlers of the moment the menu opened (a new version may have come since).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const realFrame = hasDom ? window.requestAnimationFrame : undefined;
let root: Root | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  window.requestAnimationFrame = realFrame!;
});

const at = (day: number) => new Date(Date.UTC(2026, 10, day, 9)).toISOString();
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => await new Promise((r) => setTimeout(r, 5)));
}
async function pick(key: string) {
  await act(async () => document.querySelector<HTMLElement>(`[data-plan-menu] [data-plan-menu-row="${key}"]`)!.click());
  await settle();
}

test.skipIf(!hasDom)('the decision’s mark: a press pins its card (the decision, its version and when, the moved notice with its Dismiss), Escape and a second press close it', async () => {
  const { PlanDecisionMark } = await import('./PlanDecision');
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  let dismissed = 0;
  const info = { tone: 'approved' as const, words: 'Approved by you, with notes', version: 4, at: at(5), moved: { words: 'Your approval moved to v4.', dismiss: () => void dismissed++ } };
  act(() => root!.render(<PlanDecisionMark info={info} />));
  const mark = host.querySelector<HTMLButtonElement>('[data-plan-decision-mark]')!;
  expect(mark.getAttribute('aria-label')).toBe('Approved by you, with notes');
  const card = () => document.querySelector('[data-plan-decision-card]');
  expect(card()).toBeNull();
  await act(async () => mark.click());
  await settle();
  expect(card()).not.toBeNull();
  // Drawn inside the Inbox's root (its theme), and announced from the mark.
  expect(card()!.closest('.pn-inbox')).toBe(host);
  expect(mark.getAttribute('aria-expanded')).toBe('true');
  expect(text(card()!.querySelector('.ib-plan-dcard-line'))).toBe('Approved by you, with notes');
  expect(text(card()!.querySelector('[data-plan-decision-when] b'))).toBe('v4');
  expect(card()!.querySelector('[data-plan-decision-when] time')!.getAttribute('datetime')).toBe(at(5));
  expect(text(card()!.querySelector('[data-plan-approval="moved"]'))).toBe('Your approval moved to v4.');
  await act(async () => card()!.querySelector<HTMLButtonElement>('[data-plan-approval-dismiss]')!.click());
  expect(dismissed).toBe(1);
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await settle();
  expect(card()).toBeNull();
  await act(async () => mark.click());
  await settle();
  expect(card()).not.toBeNull();
  await act(async () => mark.click());
  await settle();
  expect(card()).toBeNull();
});

test.skipIf(!hasDom)('a phone’s menu row acts with the page’s handlers as they are when it is pressed', async () => {
  const { PlanMenu } = await import('./PlanChrome');
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number) as typeof window.requestAnimationFrame;
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  const called: string[] = [];
  let edit = () => void called.push('first');
  act(() => root!.render(<PlanMenu phone items={() => [{ key: 'edit', icon: 'pen', label: 'Edit', act: () => edit() }, { key: 'restore', icon: 'restart', label: 'Restore v1', act: edit }]} />));
  await act(async () => host.querySelector<HTMLButtonElement>('[data-plan-more]')!.click());
  await settle();
  // A new version came while the menu was open: the page's handlers are new, the menu was not drawn again.
  edit = () => void called.push('second');
  await pick('restore');
  expect(called).toEqual(['second']);
});
