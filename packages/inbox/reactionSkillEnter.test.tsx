/**
 * The saved emoji's name field with "/" (approval "inbox-reactions-every-message", item 6): Enter takes the skill the
 * list shows first, and words after "/" that name no skill are never saved as one. Failures to catch (a hands-on QA
 * of main, 2026-11-24): "/tid" + Enter saved the skill `tid` though `tidy-notes` was the only row (no row was active
 * until ArrowDown); "/zzz" + Enter saved `zzz`, a skill nobody has.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { applyInboxReactionChange, parseInboxReactionChange, type InboxReaction } from '@plannotator/core/inbox-types';
import { resetSkillCatalogCache, resetSkillCatalogTransport, setSkillCatalogTransport } from '@plannotator/ui/utils/skillCatalog';

const hasDom = typeof document !== 'undefined';
const { ReactionTray } = (hasDom ? await import('./components/ReactionTray') : {}) as typeof import('./components/ReactionTray');
const { resetSavedReactionsForTests, savedReactions } = await import('./reactions');

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
let changes: unknown[] = [];
let onServer: InboxReaction[] = [];
let rev = 0;

beforeEach(() => {
  if (!hasDom) return;
  changes = [];
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (body.reaction_change) changes.push(body.reaction_change);
    const change = parseInboxReactionChange(body.reaction_change);
    const next = change ? applyInboxReactionChange(onServer, change) : null;
    if (next) {
      onServer = next;
      rev += 1;
    }
    return new Response(JSON.stringify({ reactions: onServer, reactions_rev: rev }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  resetSkillCatalogCache();
  setSkillCatalogTransport(async () => [
    { name: 'tidy-notes', root: 'claude', description: 'Tidy the release notes', humanOnly: false },
    { name: 'test-it', root: 'claude', description: 'Run it and show me', humanOnly: false },
  ]);
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.fetch = savedFetch;
  resetSavedReactionsForTests();
  resetSkillCatalogTransport();
  resetSkillCatalogCache();
  document.body.innerHTML = '';
});

const settle = (ms = 60) => act(() => new Promise<void>((done) => setTimeout(done, ms)));
const $ = (selector: string) => document.querySelector<HTMLElement>(selector);

async function press(el: HTMLElement) {
  await act(async () => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    el.click();
  });
  await settle();
}

/** The tray, + and 🚀: the name field over the tray, with `words` typed into it. */
async function nameField(words: string): Promise<HTMLInputElement> {
  resetSavedReactionsForTests([]);
  onServer = [];
  rev = 0;
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <div className="ib-pfoot">
        <ReactionTray messageId="msg_1" agent="Claude Code" on={false} current={null} phone={false} onAck={() => {}} />
      </div>,
    ),
  );
  await settle();
  const more = $('[data-react-more]')!;
  await act(async () => {
    more.focus();
    more.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await settle();
  if (!$('[data-reaction-tray]')) await press(more);
  await press($('[data-reaction="add"]')!);
  await settle(80);
  await act(async () => $('.ib-emo [data-emo="🚀"]')!.click());
  await settle(220);
  const field = $('[data-name-field]') as HTMLInputElement;
  expect(field).not.toBeNull();
  await act(async () => {
    field.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, words);
    field.setSelectionRange(words.length, words.length);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  return field;
}

async function enter(field: HTMLInputElement) {
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  await settle(300);
}

const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];

test.skipIf(!hasDom)('"/tid" shows tidy-notes active, and Enter saves the emoji with the skill tidy-notes', async () => {
  const field = await nameField('/tid');
  // The list's first row is active as it opens: Enter is aimed at it.
  expect(options().map((o) => o.textContent?.includes('tidy-notes'))).toEqual([true]);
  expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
  await enter(field);
  expect(savedReactions()).toEqual([{ emoji: '🚀', skill: 'tidy-notes' }]);
  expect(changes).toContainEqual({ op: 'skill', emoji: '🚀', skill: 'tidy-notes' });
  expect(changes).not.toContainEqual(expect.objectContaining({ skill: 'tid' }));
  // The field is gone: the tray is back.
  expect($('[data-name-field]')).toBeNull();
});

test.skipIf(!hasDom)('"/t" lists both and Enter takes the first listed; a name before the skill is kept too', async () => {
  const field = await nameField('Tidy /t');
  expect(options().length).toBe(2);
  await enter(field);
  expect(savedReactions()).toEqual([{ emoji: '🚀', label: 'Tidy', skill: 'tidy-notes' }]);
});

test.skipIf(!hasDom)('an exact name typed in full is saved as it is', async () => {
  const field = await nameField('/test-it');
  await enter(field);
  expect(savedReactions()).toEqual([{ emoji: '🚀', skill: 'test-it' }]);
});

test.skipIf(!hasDom)('"/zzz" names no skill: Enter saves no skill and the field stays open; the field is not painted as a skill', async () => {
  const field = await nameField('/zzz');
  expect(options()).toEqual([]);
  expect(field.hasAttribute('data-skill')).toBe(false);
  await enter(field);
  expect($('[data-name-field]')).not.toBeNull();
  expect(savedReactions()).toEqual([{ emoji: '🚀' }]);
  expect(changes).not.toContainEqual(expect.objectContaining({ op: 'skill' }));
});

async function keyIn(field: HTMLInputElement, key: string) {
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
  await settle();
}

function withCatalog(skills: { name: string; root: 'claude' | 'plannotator' }[]) {
  resetSkillCatalogCache();
  setSkillCatalogTransport(async () => skills.map((s) => ({ ...s, description: `About ${s.name}`, humanOnly: false })));
}

test.skipIf(!hasDom)('a name typed in full wins over a Plannotator skill listed first: "/review" + Enter keeps review', async () => {
  withCatalog([{ name: 'plannotator-review', root: 'plannotator' }, { name: 'review', root: 'claude' }]);
  const field = await nameField('/review');
  // The list keeps its order (Plannotator's first); the exact name is the active row.
  expect(options().length).toBe(2);
  expect(options()[0]!.textContent).toContain('plannotator-review');
  expect(options()[0]!.getAttribute('aria-selected')).toBe('false');
  expect(options()[1]!.getAttribute('aria-selected')).toBe('true');
  await enter(field);
  expect(savedReactions()).toEqual([{ emoji: '🚀', skill: 'review' }]);
});

test.skipIf(!hasDom)('the arrows move from the exact name\'s row; ArrowDown then Enter takes the row it landed on', async () => {
  withCatalog([{ name: 'plannotator-review', root: 'plannotator' }, { name: 'review', root: 'claude' }]);
  const field = await nameField('/review');
  await keyIn(field, 'ArrowUp');
  expect(options().map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false']);
  await keyIn(field, 'ArrowUp');
  expect(options().map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'true']);
  await keyIn(field, 'ArrowDown');
  expect(options().map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false']);
  await enter(field);
  expect(savedReactions()).toEqual([{ emoji: '🚀', skill: 'plannotator-review' }]);
});

test.skipIf(!hasDom)('a bare "/" + Enter saves no skill: nothing is active until a letter is typed', async () => {
  withCatalog([{ name: 'picture-it', root: 'plannotator' }, { name: 'tidy-notes', root: 'claude' }]);
  const field = await nameField('/');
  expect(options().length).toBe(2);
  expect(options().some((o) => o.getAttribute('aria-selected') === 'true')).toBe(false);
  await enter(field);
  expect(savedReactions()[0]!.skill).toBeUndefined();
  expect(changes).not.toContainEqual(expect.objectContaining({ op: 'skill' }));
});

test.skipIf(!hasDom)('the skill list could not be read: "/test-it" + Enter keeps the name as typed (unknown is not missing)', async () => {
  resetSkillCatalogCache();
  setSkillCatalogTransport(async () => {
    throw new Error('offline');
  });
  const field = await nameField('/test-it');
  expect(options()).toEqual([]);
  await enter(field);
  expect($('[data-name-field]')).toBeNull();
  expect(savedReactions()).toEqual([{ emoji: '🚀', skill: 'test-it' }]);
});
