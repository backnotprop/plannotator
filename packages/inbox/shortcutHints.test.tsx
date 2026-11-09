/**
 * Keycaps and `aria-keyshortcuts` come from the registry, and the two
 * keyboard settings act on them (approval "inbox-keyboard-shortcuts"). What
 * would regress:
 *
 * - a hand-written `<kbd>` or `aria-keyshortcuts` literal in the Inbox (its key
 *   drifts from the key that acts; the settings never reach it);
 * - Show keys on buttons off still drawing a keycap, or dropping
 *   `aria-keyshortcuts` with it (a screen reader would lose the key);
 * - Single-key shortcuts off still naming a single key that no longer acts,
 *   or dropping a chord that still does;
 * - the settings not surviving a reload (their cookies).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const hint = (hasDom ? await import('./shortcuts/hint') : {}) as typeof import('./shortcuts/hint');
const prefs = (hasDom ? await import('./shortcuts/prefs') : {}) as typeof import('./shortcuts/prefs');
const scopes = (hasDom ? await import('./shortcuts') : {}) as typeof import('./shortcuts');

let root: Root | null = null;
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  prefs.setKeyHints(true);
  prefs.setSingleKeys(true);
});

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

test('no keycap or aria-keyshortcuts is written by hand anywhere in the Inbox', () => {
  const offenders: string[] = [];
  for (const file of sources(import.meta.dir)) {
    const name = relative(import.meta.dir, file);
    if (name === join('shortcuts', 'hint.tsx')) continue;
    const text = readFileSync(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      if (/^\s*(\*|\/\/)/.test(line)) return;
      // The drawing screen's line names the image annotator's own keys (packages/ui ImageAnnotator: Enter adds,
      // Escape cancels), which no Inbox scope binds; it is the one hand-written keycap.
      if (name === join('components', 'Markup.tsx') && line.includes('className="ib-markkey"')) return;
      if (/<kbd[\s>]/.test(line) || /aria-keyshortcuts=["'`]/.test(line) || /aria-keyshortcuts=\{\s*["'`]/.test(line) || /aria-keyshortcuts=\{[^}]*\?\s*["'`]/.test(line)) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
    });
  }
  expect(offenders).toEqual([]);
});

function mount(node: React.ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

test.skipIf(!hasDom)('keycaps follow Show keys on buttons; aria-keyshortcuts stays', () => {
  const { ShortcutHint, shortcutAria } = hint;
  const host = mount(
    <>
      <ShortcutHint scope={scopes.inboxThreadShortcuts} action="markRead" />
      <ShortcutHint scope={scopes.inboxThreadShortcuts} action="send" />
    </>,
  );
  const shown = () => [...host.querySelectorAll('[data-shortcut-hint]')].map((el) => `${el.getAttribute('data-shortcut-hint')}=${el.getAttribute('data-keycap')}`);
  expect(shown()).toEqual(['inbox-thread.markRead=E', `inbox-thread.send=${hint.hintText({ scope: scopes.inboxThreadShortcuts, action: 'send' })}`]);
  act(() => prefs.setKeyHints(false));
  expect(shown()).toEqual([]);
  expect(shortcutAria({ scope: scopes.inboxThreadShortcuts, action: 'markRead' })).toBe('E');
  act(() => prefs.setKeyHints(true));
  expect(shown().length).toBe(2);
});

test.skipIf(!hasDom)('Single-key shortcuts off: single keys are neither drawn nor named; chords keep both', () => {
  const { ShortcutHint, shortcutAria } = hint;
  const host = mount(
    <>
      <ShortcutHint scope={scopes.inboxThreadShortcuts} action="reply" />
      <ShortcutHint scope={scopes.inboxSearchShortcuts} action="openSearch" />
    </>,
  );
  act(() => prefs.setSingleKeys(false));
  expect([...host.querySelectorAll('[data-shortcut-hint]')].map((el) => el.getAttribute('data-shortcut-hint'))).toEqual(['inbox-search.openSearch']);
  expect(shortcutAria({ scope: scopes.inboxThreadShortcuts, action: 'reply' })).toBeUndefined();
  // ⌘K stays, `/` goes.
  expect(shortcutAria({ scope: scopes.inboxSearchShortcuts, action: 'openSearch' }, prefs.shortcutPrefs(), 'mac')).toBe('Meta+K');
  act(() => prefs.setSingleKeys(true));
  expect(shortcutAria({ scope: scopes.inboxSearchShortcuts, action: 'openSearch' }, prefs.shortcutPrefs(), 'mac')).toBe('Meta+K /');
});

test.skipIf(!hasDom)('aria-keyshortcuts names each key the way assistive technology reads it', () => {
  const { ariaBinding } = hint;
  expect([ariaBinding('Mod+Enter', 'mac'), ariaBinding('Mod+Enter', 'non-mac'), ariaBinding('?'), ariaBinding('Escape'), ariaBinding('Shift+F10'), ariaBinding('G I')]).toEqual([
    'Meta+Enter',
    'Control+Enter',
    'Shift+?',
    'Escape',
    'Shift+F10',
    null,
  ]);
});

test.skipIf(!hasDom)('both settings survive a reload, and only "off" is stored', async () => {
  const storage = await import('@plannotator/ui/utils/storage');
  const stored = new Map<string, string>();
  storage.setStorageBackend({ getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => void stored.set(k, v), removeItem: (k) => void stored.delete(k) });
  try {
    prefs.setSingleKeys(false);
    prefs.setKeyHints(false);
    expect(Object.fromEntries(stored)).toEqual({ [prefs.SINGLE_KEYS_COOKIE]: 'off', [prefs.KEY_HINTS_COOKIE]: 'off' });
    prefs.reloadShortcutPrefs();
    expect(prefs.shortcutPrefs()).toEqual({ singleKeys: false, hints: false });
    prefs.setSingleKeys(true);
    prefs.setKeyHints(true);
    expect(stored.size).toBe(0);
    prefs.reloadShortcutPrefs();
    expect(prefs.shortcutPrefs()).toEqual({ singleKeys: true, hints: true });
  } finally {
    storage.resetStorageBackend();
    prefs.reloadShortcutPrefs();
  }
});
