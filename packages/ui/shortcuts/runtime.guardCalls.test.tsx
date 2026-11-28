/**
 * A scope's guard (`when`) runs for a key its bindings match, and for a key that starts one of its sequences; never for
 * any other key. A guard can read the whole page (the Inbox's dialog and selection checks walk every element), and a
 * scope used to run every guard on every key while it looked for sequences to start: on a long thread, held Backspace
 * in the reply box queued up for seconds. What would regress: a guard run for an unrelated key, a sequence that no
 * longer starts, or a guard that no longer holds a sequence or a single key back.
 * DOM test: DOM_TESTS=1.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const hasDom = typeof document !== 'undefined';
const { defineShortcutScope, useShortcutScope } = (hasDom ? await import('./index') : {}) as typeof import('./index');

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const scope = hasDom
  ? defineShortcutScope({
      id: 'guard-calls-test',
      title: 'Test',
      lettersByCode: true,
      shortcuts: {
        next: { description: 'Next', bindings: ['J'], section: 'Test' },
        goInbox: { description: 'Go to the Inbox', bindings: ['G I'], section: 'Test', preventDefault: true },
      },
    })
  : (null as never);

function harness(allow: { next: boolean; goInbox: boolean }) {
  const calls = { next: 0, goInbox: 0 };
  const fired: string[] = [];
  function Keys() {
    useShortcutScope({
      scope,
      handlers: {
        next: { when: () => (calls.next++, allow.next), handle: () => fired.push('next') },
        goInbox: { when: () => (calls.goInbox++, allow.goInbox), handle: () => fired.push('goInbox') },
      },
    });
    return <textarea data-field="" />;
  }
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Keys />));
  const field = host.querySelector('textarea')!;
  const press = (key: string, code: string, at: Element = field) =>
    act(() => {
      at.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true }));
    });
  return { calls, fired, press };
}

test.skipIf(!hasDom)('a key no binding matches and that starts no sequence runs no guard', () => {
  const { calls, fired, press } = harness({ next: true, goInbox: true });
  for (const [key, code] of [['Backspace', 'Backspace'], ['x', 'KeyX'], ['Enter', 'Enter'], ['ArrowDown', 'ArrowDown'], ['i', 'KeyI']] as const) {
    press(key, code);
  }
  expect(calls).toEqual({ next: 0, goInbox: 0 });
  expect(fired).toEqual([]);
});

test.skipIf(!hasDom)('a single key runs its own guard and fires; G then I runs the sequence’s guard and fires', () => {
  const { calls, fired, press } = harness({ next: true, goInbox: true });
  press('j', 'KeyJ');
  expect(fired).toEqual(['next']);
  expect(calls.goInbox).toBe(0);
  press('g', 'KeyG');
  // G starts the sequence: its guard is asked once, the single key's is not.
  expect(calls).toEqual({ next: 1, goInbox: 1 });
  press('i', 'KeyI');
  expect(fired).toEqual(['next', 'goInbox']);
  expect(calls.goInbox).toBe(2);
});

test.skipIf(!hasDom)('a guard that says no still holds back its single key and its sequence', () => {
  const { fired, press } = harness({ next: false, goInbox: false });
  press('j', 'KeyJ');
  press('g', 'KeyG');
  press('i', 'KeyI');
  expect(fired).toEqual([]);
});
