/**
 * ⌘K / Ctrl+K opens search: the Inbox's one keyboard shortcut, an owner
 * exception (approval amendment 2026-10-14). What is proved here, on the real
 * handler the window installs (search/searchShortcut.ts):
 *
 * - only the platform's own modifier with K counts (⌘K on macOS, Ctrl+K
 *   elsewhere); Shift, Alt, the other modifier, a bare K and a chord while an
 *   IME composes do not;
 * - from a text field (the reply box) it opens search and stops the browser's
 *   own Ctrl+K; typing there is untouched;
 * - with the palette open it goes back to the palette's input, the words
 *   selected, and opens nothing new;
 * - another modal dialog keeps the keys;
 * - the scope holds this one shortcut and nothing else;
 * - the Search entry shows the registry's keycaps and names the chord in
 *   aria-keyshortcuts.
 *
 * The whole window on the compiled binary, macOS and not: tests/e2e/inbox-search.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const shortcut = (hasDom ? await import('./search/searchShortcut') : {}) as typeof import('./search/searchShortcut');
const { validateShortcutRegistry } = (hasDom ? await import('@plannotator/ui/shortcuts') : {}) as typeof import('@plannotator/ui/shortcuts');
const { Sidebar } = (hasDom ? await import('./components/Sidebar') : {}) as typeof import('./components/Sidebar');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

let root: Root | null = null;
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', bubbles: true, cancelable: true, ...init });

test.skipIf(!hasDom)('only the platform modifier with K is the chord', () => {
  const { isOpenSearchKey } = shortcut;
  // Not macOS: Ctrl+K.
  expect(isOpenSearchKey(key({ ctrlKey: true }), false)).toBe(true);
  expect(isOpenSearchKey(key({ ctrlKey: true, key: 'K' }), false)).toBe(true);
  for (const init of [{ metaKey: true }, { ctrlKey: true, shiftKey: true }, { ctrlKey: true, altKey: true }, { ctrlKey: true, metaKey: true }, {}, { ctrlKey: true, isComposing: true }, { ctrlKey: true, key: 'j', code: 'KeyJ' }])
    expect([init, isOpenSearchKey(key(init), false)]).toEqual([init, false]);
  // macOS: ⌘K; Ctrl+K stays the text field's delete-to-end-of-line.
  expect(isOpenSearchKey(key({ metaKey: true }), true)).toBe(true);
  for (const init of [{ ctrlKey: true }, { metaKey: true, shiftKey: true }, { metaKey: true, ctrlKey: true }, { metaKey: true, isComposing: true }])
    expect([init, isOpenSearchKey(key(init), true)]).toEqual([init, false]);
});

test.skipIf(!hasDom)('from the reply box it opens search and stops the browser\'s Ctrl+K; typing there is untouched', () => {
  const reply = document.createElement('textarea');
  document.body.appendChild(reply);
  reply.focus();
  const opened: (HTMLElement | null)[] = [];
  const typed = key({});
  shortcut.onOpenSearchKey(typed, (opener) => opened.push(opener), false);
  expect([opened, typed.defaultPrevented]).toEqual([[], false]);
  const chord = key({ ctrlKey: true });
  shortcut.onOpenSearchKey(chord, (opener) => opened.push(opener), false);
  expect(opened).toEqual([reply]);
  expect(chord.defaultPrevented).toBe(true);
});

test.skipIf(!hasDom)('with the palette open it goes back to the palette\'s input, the words selected; another modal dialog keeps the keys', () => {
  const opened: (HTMLElement | null)[] = [];
  const palette = document.createElement('dialog');
  palette.setAttribute('data-search-palette', '');
  palette.setAttribute('open', '');
  const input = document.createElement('input');
  input.setAttribute('role', 'combobox');
  input.value = 'rate limit';
  palette.appendChild(input);
  const chip = document.createElement('button');
  palette.appendChild(chip);
  document.body.appendChild(palette);
  chip.focus();
  const again = key({ metaKey: true });
  shortcut.onOpenSearchKey(again, (opener) => opened.push(opener), true);
  expect(opened).toEqual([]);
  expect(again.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(input);
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'rate limit'.length]);
  palette.remove();
  // The update, sound and agent-note dialogs are native modal dialogs.
  const modal = document.createElement('dialog');
  modal.className = 'ib-dlg';
  modal.setAttribute('open', '');
  document.body.appendChild(modal);
  const blocked = key({ metaKey: true });
  shortcut.onOpenSearchKey(blocked, (opener) => opened.push(opener), true);
  expect([opened, blocked.defaultPrevented]).toEqual([[], false]);
});

test.skipIf(!hasDom)('/ opens search where nobody is typing, and never in a field, a dialog, with a modifier, or with single keys off', async () => {
  const prefs = await import('./shortcuts/prefs');
  const slash = (target: EventTarget, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key: '/', code: 'Slash', bubbles: true, cancelable: true, ...init });
    const opened: (HTMLElement | null)[] = [];
    target.addEventListener('keydown', (e) => shortcut.onOpenSearchKey(e as KeyboardEvent, (opener) => opened.push(opener), true), { once: true });
    target.dispatchEvent(event);
    return { opened: opened.length, prevented: event.defaultPrevented };
  };
  const row = document.createElement('button');
  const field = document.createElement('textarea');
  document.body.append(row, field);
  row.focus();
  expect(slash(row)).toEqual({ opened: 1, prevented: true });
  // Where `/` is Shift+7 (German, Swiss, Nordic layouts) it is still the key that types `/`.
  expect(slash(row, { shiftKey: true, code: 'Digit7' })).toEqual({ opened: 1, prevented: true });
  // Typing a slash in the reply box is a slash.
  expect(slash(field)).toEqual({ opened: 0, prevented: false });
  expect(slash(row, { ctrlKey: true })).toEqual({ opened: 0, prevented: false });
  expect(slash(row, { isComposing: true })).toEqual({ opened: 0, prevented: false });
  const modal = document.createElement('dialog');
  modal.setAttribute('open', '');
  document.body.appendChild(modal);
  expect(slash(row)).toEqual({ opened: 0, prevented: false });
  modal.remove();
  prefs.setSingleKeys(false);
  try {
    expect(slash(row)).toEqual({ opened: 0, prevented: false });
  } finally {
    prefs.setSingleKeys(true);
  }
});

test.skipIf(!hasDom)('the scope holds this one shortcut, and the registry accepts it', () => {
  const { inboxSearchShortcuts, OPEN_SEARCH_BINDING } = shortcut;
  expect(Object.keys(inboxSearchShortcuts.shortcuts)).toEqual(['openSearch']);
  expect(OPEN_SEARCH_BINDING).toBe('Mod+K');
  expect(validateShortcutRegistry([inboxSearchShortcuts])).toEqual([]);
  expect(shortcut.openSearchHint('mac')).toBe('⌘K');
  expect(shortcut.openSearchHint('non-mac')).toBe('Ctrl K');
  expect([shortcut.openSearchAriaKeys(true), shortcut.openSearchAriaKeys(false)]).toEqual(['Meta+K', 'Control+K']);
});

test.skipIf(!hasDom)('the Search entry shows the keycaps and names the chord', () => {
  const host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  root = createRoot(host);
  const noop = () => {};
  act(() =>
    root!.render(
      <SidebarProvider>
        <Sidebar
          page="inbox"
          projectId={null}
          inboxCount={0}
          projects={[]}
          projectCounts={new Map()}
          update={null}
          restarting={false}
          updated={null}
          onInbox={noop}
          onProject={noop}
          onSettings={noop}
          onUpdate={noop}
          onWhatsNew={noop}
          onSearch={noop}
        />
      </SidebarProvider>,
    ),
  );
  const entry = host.querySelector<HTMLButtonElement>('.ib-sp-entry')!;
  // The chord, and `/` (an extra, on).
  expect(entry.getAttribute('aria-keyshortcuts')).toBe(`${shortcut.openSearchAriaKeys()} /`);
  const hint = entry.querySelector('[data-shortcut-hint="inbox-search.openSearch"]')!;
  expect(hint.getAttribute('data-keycap')).toBe(shortcut.openSearchHint());
  expect(hint.getAttribute('aria-hidden')).toBe('true');
});
