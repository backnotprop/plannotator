/**
 * The bridge offering a plain `]` or `[` to its host as `step` (the Inbox steps through a thread's files on it).
 * Armed (Annotate), it posts at once. In Interact it posts only a key the page did not use: after every handler had
 * its turn, when the key reached the window and nobody cancelled it. Never from a text field, with a modifier, on
 * auto-repeat, mid-composition or under Vim.
 *
 * Evaluates the SHIPPED function out of the bridge's string with small fakes. What would regress: a page that uses
 * `]` itself also stepping the host in Interact, or Interact offering nothing at all.
 */
import { expect, test } from 'bun:test';
import { BRIDGE_SCRIPT } from './bridge-script';

function extractFunction(name: string): string {
  const start = BRIDGE_SCRIPT.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`bridge no longer defines ${name}`);
  let depth = 0;
  for (let i = BRIDGE_SCRIPT.indexOf('{', start); i < BRIDGE_SCRIPT.length; i += 1) {
    if (BRIDGE_SCRIPT[i] === '{') depth += 1;
    else if (BRIDGE_SCRIPT[i] === '}') {
      depth -= 1;
      if (depth === 0) return BRIDGE_SCRIPT.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces around ${name}`);
}

interface Key {
  key: string;
  target?: unknown;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
}

/** The bridge's step key in a page, armed or not. */
function bridge(options: { armed: boolean; vim?: boolean }) {
  const posted: Record<string, unknown>[] = [];
  const timers: (() => void)[] = [];
  const api = new Function(
    'PREFIX',
    'postToParent',
    'setTimeout',
    'annotateModeActive',
    'vimEnabled',
    `var stepKeyReachedWindow = null;
     ${extractFunction('offerStepKey')}
     return { offer: offerStepKey, reached: function(e) { stepKeyReachedWindow = e; } };`,
  )('plannotator-bridge-', (m: Record<string, unknown>) => posted.push(m), (fn: () => void) => timers.push(fn), options.armed, options.vim === true) as {
    offer: (e: Key) => void;
    reached: (e: Key | null) => void;
  };
  /** One key through the page: the bridge's capture listener, the page's handlers (`page`), then the timers. */
  const press = (e: Key, page: (e: Key) => 'used' | 'stopped' | 'none' = () => 'none') => {
    api.offer(e);
    const did = page(e);
    if (did === 'used') e.defaultPrevented = true;
    if (did !== 'stopped') api.reached(e);
    for (const run of timers.splice(0)) run();
  };
  return { posted, press };
}

const field = { nodeType: 1, tagName: 'INPUT', isContentEditable: false, closest: () => null };
const button = { nodeType: 1, tagName: 'BUTTON', isContentEditable: false, closest: () => null };

test('armed: ] and [ post at once, even a key the page then uses', () => {
  const { posted, press } = bridge({ armed: true });
  press({ key: ']', target: button }, () => 'used');
  press({ key: '[', target: button });
  expect(posted).toEqual([
    { type: 'plannotator-bridge-step', dir: 1 },
    { type: 'plannotator-bridge-step', dir: -1 },
  ]);
});

test('Interact: only a key the page did not use is offered; one it cancelled or stopped stays the page’s', () => {
  const { posted, press } = bridge({ armed: false });
  press({ key: ']', target: button });
  press({ key: ']', target: button }, () => 'used');
  press({ key: '[', target: button }, () => 'stopped');
  press({ key: '[', target: button });
  expect(posted).toEqual([
    { type: 'plannotator-bridge-step', dir: 1 },
    { type: 'plannotator-bridge-step', dir: -1 },
  ]);
});

test('never from a text field, with a modifier, on repeat, mid-composition, or under Vim', () => {
  for (const armed of [true, false]) {
    const { posted, press } = bridge({ armed });
    press({ key: ']', target: field });
    press({ key: ']', target: button, metaKey: true });
    press({ key: ']', target: button, ctrlKey: true });
    press({ key: ']', target: button, altKey: true });
    press({ key: ']', target: button, repeat: true });
    press({ key: ']', target: button, isComposing: true });
    press({ key: 'a', target: button });
    expect(posted).toEqual([]);
    const vim = bridge({ armed, vim: true });
    vim.press({ key: ']', target: button });
    expect(vim.posted).toEqual([]);
  }
});
