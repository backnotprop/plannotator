/**
 * Trust and start, as compose draws it (approval "inbox-launch-trust-compose"): the real ComposeDialog over its
 * `transport` seam, which plays the server. `offered` says what the server would answer for the folder To names (its
 * facts only once that folder is picked, as `GET /api/inbox/sessions` does). The gate and the order are the server's:
 * packages/server/inbox-launch-trust-send.test.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxLaunchUntrusted } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { ComposeDialog } = (hasDom ? await import('./compose/ComposeDialog') : {}) as typeof import('./compose/ComposeDialog');
const { InboxApiError } = (hasDom ? await import('./api') : {}) as typeof import('./api');

const AGENT = 'claude-code';
const FOLDER = '/Users/me/work/billing';
const CIRCLE = '[data-compose-trust-circle]';
const DETAILS = '[data-compose-trust-ask]';
const SEND = '[data-compose-send]';
const REPO_FACT = 'Whole repository, not just billing-worktree';
const HOOK_FACT = 'Runs 4 hooks, 2 MCP servers, 1 helper command, env settings';

const clean = (): InboxLaunchUntrusted => ({ folder: FOLDER, facts: [], warns: false });
const hooks = (): InboxLaunchUntrusted => ({ folder: FOLDER, facts: [HOOK_FACT], warns: true });
const wholeRepo = (): InboxLaunchUntrusted => ({ folder: '/Users/me/work/billing-platform', facts: [REPO_FACT], warns: false });

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
/** The server's offer by pick; absent: the folder is trusted, has no offer (home), or the reader is a guest. */
let offered: Record<string, InboxLaunchUntrusted | undefined>;
/** The agent does not trust the scratch root, and there is no offer for it. */
let scratchUntrusted: boolean;
/** Holds an answer back, to catch a press before the facts arrive. */
let sessionsGate: Promise<void> | null;
/** How long a read takes: over the 5 s refresh, every answer has a newer read behind it. */
let sessionsMs: number;
/** Holds back the answers for one pick, which then land after the next pick's. */
let heldPick: { project: string; gate: Promise<void> } | null;
let sends: { launch: Record<string, unknown>; body: string }[];
let sendAnswer: (() => Promise<never>) | null;
let sentOk: unknown[];
let closed: number;

const model = (pick: { project: string } | null) => {
  const untrusted: Record<string, InboxLaunchUntrusted> = {};
  for (const [id, entry] of Object.entries(offered)) {
    // The refresh names no facts for a folder that isn't the pick.
    if (entry) untrusted[id] = pick?.project === id ? entry : { folder: entry.folder };
  }
  return {
    serverSession: 's',
    home: '/Users/me',
    projects: [],
    launch: {
      agents: [{ agent: AGENT as 'claude-code', name: 'Claude Code', scratch_trusted: !offered.scratch && !scratchUntrusted, untrusted }],
      projects: [{ id: 'p1', name: 'billing', root: FOLDER, exists: true }],
      scratch: { root: '/data/scratch' },
    },
  };
};

beforeEach(() => {
  if (!hasDom) return;
  offered = {};
  scratchUntrusted = false;
  sessionsGate = null;
  sessionsMs = 0;
  heldPick = null;
  sends = [];
  sendAnswer = null;
  sentOk = [];
  closed = 0;
  savedFetch = globalThis.fetch;
  // The login shell read ahead (`launchSettingsRead`): its answer is unused.
  globalThis.fetch = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
});

const dialog = () => document.querySelector('dialog[data-compose]') as HTMLDialogElement;
const inDialog = <T extends Element = HTMLElement>(selector: string) => dialog().querySelector<T>(selector);
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

async function until(check: () => boolean, what: string, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function open(phone = false) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <ComposeDialog
        request={{}}
        phone={phone}
        current={{ id: 'p1', root: FOLDER, name: 'billing' }}
        lastSent={null}
        home="/Users/me"
        onSent={(sent) => sentOk.push(sent)}
        onSaved={() => {}}
        onDeleted={() => {}}
        onClose={() => closed++}
        transport={{
          sessions: async (pick) => {
            await sessionsGate;
            if (sessionsMs) await new Promise((r) => setTimeout(r, sessionsMs));
            if (heldPick && pick?.project === heldPick.project) await heldPick.gate;
            return model(pick);
          },
          startThread: async (input) => {
            sends.push({ launch: (input.to as { launch: Record<string, unknown> }).launch, body: input.body });
            if (sendAnswer) return sendAnswer();
            return { thread_id: 't1' };
          },
          drafts: true,
          uploads: false,
        }}
      />,
    );
  });
  await until(() => inDialog('button[data-compose-to]:not([data-loading])') !== null, 'To', sessionsMs ? 900 : 100);
}

/** New Claude Code session in the current project, as a person picks it. */
async function pickStart(phone = false) {
  await open(phone);
  await chooseStart();
}

async function chooseStart() {
  act(() => inDialog('button[data-compose-to]')!.click());
  await until(() => inDialog(`[data-compose-start="${AGENT}"]`) !== null, 'the start row');
  act(() => inDialog(`[data-compose-start="${AGENT}"]`)!.click());
  await until(() => inDialog('[data-compose-to="start"]') !== null, 'To names the start');
  await flush();
}

function type(words: string) {
  const text = inDialog<HTMLTextAreaElement>('textarea')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(text, words);
    text.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const press = async (selector: string) => {
  act(() => inDialog(selector)!.click());
  await flush();
};

const keydown = (target: Element, key: string, extra: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
};

const label = () => inDialog(SEND)!.textContent!.replace(/\s+/g, ' ').trim();

test.skipIf(!hasDom)('a clean folder: Trust and start, no circle, and the press carries the reading it was on', async () => {
  offered = { p1: clean() };
  await pickStart();
  type('Tidy the readme.');
  expect(label()).toStartWith('Trust and start');
  expect(label()).not.toContain('…');
  expect(inDialog(CIRCLE)).toBeNull();
  await press(SEND);
  expect(sends).toEqual([{ launch: { agent: AGENT, project_id: 'p1', trust: { folder: FOLDER, facts: [] } }, body: 'Tidy the readme.' }]);
  // No confirm between the press and the Send.
  expect(sentOk).toHaveLength(1);
});

test.skipIf(!hasDom)('a folder with hooks: the circle is a named button in the warning color, with no tooltip and no added words', async () => {
  offered = { p1: hooks() };
  await pickStart();
  const circle = inDialog<HTMLButtonElement>(CIRCLE)!;
  expect(circle.tagName).toBe('BUTTON');
  expect(circle.getAttribute('aria-label')).toBe('What trusting this folder means');
  expect(circle.getAttribute('title')).toBeNull();
  expect(circle.hasAttribute('data-warning')).toBe(true);
  expect(circle.textContent).toBe('');
  expect(label()).toStartWith('Trust and start');
  expect(inDialog(DETAILS)).toBeNull();
});

test.skipIf(!hasDom)('only the whole repository: the circle is there and quiet, and its details name the folder actually trusted', async () => {
  offered = { p1: wholeRepo() };
  await pickStart();
  expect(inDialog(CIRCLE)!.hasAttribute('data-warning')).toBe(false);
  await press(CIRCLE);
  const details = inDialog(DETAILS)!;
  expect(details.querySelector('h5')!.textContent).toBe('Trust ~/work/billing-platform?');
  expect(details.textContent).toContain(REPO_FACT);
  expect(details.querySelector('button')).toBeNull();
});

test.skipIf(!hasDom)('a trusted folder: plain Send, no circle, and the Send carries no trust', async () => {
  await pickStart();
  type('Tidy the readme.');
  expect(label()).toStartWith('Send');
  expect(inDialog(CIRCLE)).toBeNull();
  await press(SEND);
  expect(sends[0]!.launch).toEqual({ agent: AGENT, project_id: 'p1' });
});

test.skipIf(!hasDom)('a guest, or home: `untrusted` says nothing, so there is no offer anywhere', async () => {
  // The same answer for both: the folder is not listed.
  offered = { p1: undefined };
  await pickStart();
  expect(label()).toStartWith('Send');
  expect(inDialog(CIRCLE)).toBeNull();
  expect(inDialog(DETAILS)).toBeNull();
});

test.skipIf(!hasDom)('the status line about starting a session is gone, on every launch', async () => {
  for (const entry of [undefined, clean(), hooks()]) {
    offered = { p1: entry };
    await pickStart();
    expect(inDialog('[data-compose-status]')).toBeNull();
    act(() => root?.unmount());
    host?.remove();
  }
  root = null;
  host = null;
});

test.skipIf(!hasDom)('the circle opens and closes the details, and nothing else moves: pressing again, or pressing outside', async () => {
  offered = { p1: hooks() };
  await pickStart();
  await press(CIRCLE);
  expect(inDialog(CIRCLE)!.getAttribute('aria-expanded')).toBe('true');
  expect(inDialog(CIRCLE)!.getAttribute('aria-controls')).toBe(inDialog(DETAILS)!.id);
  expect(inDialog(DETAILS)!.textContent).toContain(HOOK_FACT);
  await press(CIRCLE);
  expect(inDialog(DETAILS)).toBeNull();

  await press(CIRCLE);
  // A press inside stays open.
  act(() => {
    inDialog(`${DETAILS} h5`)!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  });
  expect(inDialog(DETAILS)).not.toBeNull();
  act(() => {
    inDialog('textarea')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  });
  expect(inDialog(DETAILS)).toBeNull();
  expect(closed).toBe(0);
});

test.skipIf(!hasDom)('Escape closes the details first: the dialog stays, the words stay, and focus goes back to the circle', async () => {
  offered = { p1: hooks() };
  await pickStart();
  type('Do not lose this.');
  await press(CIRCLE);
  inDialog(CIRCLE)!.focus();
  keydown(inDialog(CIRCLE)!, 'Escape');
  await flush();
  expect(inDialog(DETAILS)).toBeNull();
  expect(closed).toBe(0);
  expect(inDialog('[data-compose-question]')).toBeNull();
  expect(inDialog<HTMLTextAreaElement>('textarea')!.value).toBe('Do not lose this.');
  expect(document.activeElement).toBe(inDialog(CIRCLE));
  // The next Escape is the dialog's own: words, so it asks.
  keydown(inDialog(CIRCLE)!, 'Escape');
  await flush();
  expect(inDialog('[data-compose-question]')).not.toBeNull();
});

test.skipIf(!hasDom)('from the text field Escape keeps the caret where it is', async () => {
  offered = { p1: hooks() };
  await pickStart();
  type('Do not lose this.');
  await press(CIRCLE);
  inDialog('textarea')!.focus();
  keydown(inDialog('textarea')!, 'Escape');
  await flush();
  expect(inDialog(DETAILS)).toBeNull();
  expect(document.activeElement).toBe(inDialog('textarea'));
});

test.skipIf(!hasDom)('a press before the facts arrived still says what it saw: nothing, so the server can refuse a folder that has some', async () => {
  offered = { p1: hooks() };
  await open();
  // The refresh knows the folder is untrusted; the read that names the pick has not answered.
  let openGate = () => {};
  sessionsGate = new Promise((r) => (openGate = r));
  act(() => inDialog('button[data-compose-to]')!.click());
  await until(() => inDialog(`[data-compose-start="${AGENT}"]`) !== null, 'the start row');
  act(() => inDialog(`[data-compose-start="${AGENT}"]`)!.click());
  await until(() => inDialog('[data-compose-to="start"]') !== null, 'To names the start');
  expect(label()).toStartWith('Trust and start');
  expect(inDialog(CIRCLE)).toBeNull();
  type('Quick one.');
  await press(SEND);
  expect(sends[0]!.launch.trust).toEqual({ folder: FOLDER, facts: [] });
  openGate();
});

test.skipIf(!hasDom)('a read slower than the refresh still lands: New message loads and Send sends', async () => {
  sessionsMs = 6_000;
  await open();
  sessionsMs = 0;
  await chooseStart();
  type('Tidy the readme.');
  await press(SEND);
  expect(sends).toHaveLength(1);
}, 15_000);

test.skipIf(!hasDom)('an answer for the folder picked before is dropped: it never takes the new folder its facts', async () => {
  offered = { p1: hooks(), scratch: { folder: '/data/scratch', facts: ['Runs 1 hook'], warns: true } };
  await open();
  let release = () => {};
  heldPick = { project: 'p1', gate: new Promise((r) => (release = r)) };
  await chooseStart();
  await press('[data-compose-folder]');
  await press('[data-compose-folder-option="scratch"]');
  await until(() => inDialog(CIRCLE) !== null, 'the scratch facts');
  release();
  await flush();
  await flush();
  expect(inDialog(CIRCLE)).not.toBeNull();
});

test.skipIf(!hasDom)('the folder changed: nothing sent, the new facts are read and shown, the words stay, and the next press is on the new reading', async () => {
  offered = { p1: hooks() };
  await pickStart();
  type('Tidy the readme.');
  const changed: InboxLaunchUntrusted = { folder: FOLDER, facts: ['Runs 9 hooks'], warns: true };
  sendAnswer = async () => {
    offered = { p1: changed };
    throw new InboxApiError(409, 'trust_warning_changed', 'This folder changed. Nothing was trusted or sent.');
  };
  const clock = spyOn(Date, 'now');
  const at = Date.now();
  clock.mockReturnValue(at);
  try {
    await press(SEND);
    await until(() => inDialog(DETAILS) !== null, 'the details');
    expect(inDialog(DETAILS)!.textContent).toContain('Runs 9 hooks');
    expect(inDialog(DETAILS)!.textContent).not.toContain(HOOK_FACT);
    // The details lie over the error line (on a phone, over the whole footer): they say it, once.
    expect(inDialog(`${DETAILS} [role="alert"]`)!.textContent).toContain('This folder changed');
    expect(dialog().querySelectorAll('[data-compose-error]')).toHaveLength(1);
    expect(sentOk).toHaveLength(0);
    expect(inDialog<HTMLTextAreaElement>('textarea')!.value).toBe('Tidy the readme.');

    sendAnswer = null;
    // A second click of the double press that landed on the opened details asks nothing and sends nothing.
    await press(SEND);
    expect(sends).toHaveLength(1);

    clock.mockReturnValue(at + 700);
    await press(SEND);
    expect(sends).toHaveLength(2);
    expect(sends[1]!.launch.trust).toEqual({ folder: FOLDER, facts: ['Runs 9 hooks'] });
    expect(sentOk).toHaveLength(1);
  } finally {
    clock.mockRestore();
  }
});

test.skipIf(!hasDom)('details closed on a changed folder: the error goes back to its own line, and is not lost', async () => {
  offered = { p1: hooks() };
  await pickStart();
  type('Tidy the readme.');
  sendAnswer = async () => {
    throw new InboxApiError(409, 'trust_warning_changed', 'This folder changed. Nothing was trusted or sent.');
  };
  await press(SEND);
  await until(() => inDialog(DETAILS) !== null, 'the details');
  keydown(inDialog('textarea')!, 'Escape');
  await flush();
  expect(inDialog(DETAILS)).toBeNull();
  expect(inDialog('.ib-cp-error[role="alert"]')!.textContent).toContain('This folder changed');
});

test.skipIf(!hasDom)('while the details say the error its own line keeps its room, so a press that closes them never moves the button under it', async () => {
  offered = { p1: hooks() };
  await pickStart();
  type('Tidy the readme.');
  sendAnswer = async () => {
    throw new InboxApiError(409, 'trust_warning_changed', 'This folder changed. Nothing was trusted or sent.');
  };
  await press(SEND);
  await until(() => inDialog(DETAILS) !== null, 'the details');
  const line = inDialog('.ib-cp-error')!;
  expect(line.hasAttribute('data-in-details')).toBe(true);
  expect(line.hasAttribute('role')).toBe(false);
});

test.skipIf(!hasDom)('`trust_failed`: the reason shows, nothing is sent, the words stay and it can be pressed again', async () => {
  offered = { p1: clean() };
  await pickStart();
  type('Tidy the readme.');
  sendAnswer = async () => {
    throw new InboxApiError(500, 'trust_failed', "Claude Code's config is locked.");
  };
  await press(SEND);
  expect(inDialog('[data-compose-error]')!.textContent).toContain('config is locked');
  expect(sentOk).toHaveLength(0);
  expect(closed).toBe(0);
  expect(inDialog<HTMLTextAreaElement>('textarea')!.value).toBe('Tidy the readme.');
  sendAnswer = null;
  await press(SEND);
  expect(sentOk).toHaveLength(1);
});

test.skipIf(!hasDom)('Cmd or Ctrl+Enter does exactly what the button does, warnings included, and a held key presses once', async () => {
  for (const modifier of ['metaKey', 'ctrlKey'] as const) {
    offered = { p1: hooks() };
    sends = [];
    await pickStart();
    type('Tidy the readme.');
    const text = inDialog('textarea')!;
    keydown(text, 'Enter', { [modifier]: true, repeat: true });
    await flush();
    expect(sends).toHaveLength(0);
    keydown(text, 'Enter', { [modifier]: true });
    await flush();
    expect(sends).toEqual([{ launch: { agent: AGENT, project_id: 'p1', trust: { folder: FOLDER, facts: [HOOK_FACT] } }, body: 'Tidy the readme.' }]);
    act(() => root?.unmount());
    host?.remove();
  }
  root = null;
  host = null;
});

test.skipIf(!hasDom)('a key held on the focused button never presses it again', async () => {
  offered = { p1: clean() };
  await pickStart();
  expect(keydown(inDialog(SEND)!, 'Enter', { repeat: true }).defaultPrevented).toBe(true);
  expect(keydown(inDialog(SEND)!, ' ', { repeat: true }).defaultPrevented).toBe(true);
  expect(keydown(inDialog(SEND)!, 'Enter').defaultPrevented).toBe(false);
});

test.skipIf(!hasDom)('a scratch folder gets the same button, and the row in the menu stops speaking: the press says it', async () => {
  offered = { p1: undefined, scratch: { folder: '/data/scratch', facts: [HOOK_FACT], warns: true } };
  await pickStart();
  expect(label()).toStartWith('Send');
  await press('[data-compose-folder]');
  expect(inDialog('[data-compose-folder-option="scratch"]')!.textContent).not.toContain('trust');
  await press('[data-compose-folder-option="scratch"]');
  await until(() => inDialog(CIRCLE) !== null, 'the scratch facts');
  expect(label()).toStartWith('Trust and start');
  type('Try an idea.');
  await press(SEND);
  expect(sends[0]!.launch).toEqual({ agent: AGENT, scratch: true, trust: { folder: '/data/scratch', facts: [HOOK_FACT] } });
});

test.skipIf(!hasDom)('a scratch root nobody can trust from here (a guest, a root at home): the row still says so, since no press can', async () => {
  scratchUntrusted = true;
  await pickStart();
  await press('[data-compose-folder]');
  const row = inDialog('[data-compose-folder-option="scratch"]')!;
  expect(row.hasAttribute('data-untrusted')).toBe(true);
  expect(row.textContent).toContain('trust it once');
  await press('[data-compose-folder-option="scratch"]');
  await until(() => inDialog('[data-compose-folder="scratch"]') !== null, 'the scratch pick');
  expect(label()).toStartWith('Send');
});

test.skipIf(!hasDom)('picking another folder closes the details: they were about the last one', async () => {
  offered = { p1: hooks(), scratch: { folder: '/data/scratch', facts: ['Runs 1 hook'], warns: true } };
  await pickStart();
  await press(CIRCLE);
  expect(inDialog(DETAILS)).not.toBeNull();
  await press('[data-compose-folder]');
  await press('[data-compose-folder-option="scratch"]');
  await until(() => inDialog('[data-compose-folder="scratch"]') !== null, 'the scratch pick');
  expect(inDialog(DETAILS)).toBeNull();
});

test.skipIf(!hasDom)('a phone: button and circle in the bottom bar with no shortcut hint, Cancel and the title on top', async () => {
  offered = { p1: hooks() };
  await pickStart(true);
  const bar = inDialog('.ib-cp-bar')!;
  expect(bar.querySelector(SEND)).toBeNull();
  expect(bar.querySelector('[data-compose-cancel]')).not.toBeNull();
  expect(bar.querySelector('h2')!.textContent).toBe('New message');
  const foot = inDialog('.ib-cp-foot')!;
  expect(foot.querySelector(CIRCLE)).not.toBeNull();
  expect(foot.querySelector(SEND)!.textContent!.trim()).toBe('Trust and start');
  await press(CIRCLE);
  // The Inbox's bottom sheet on a phone is `.ib-state.ib-nmpop`, styled by the phone media rule.
  expect(inDialog(DETAILS)!.classList.contains('ib-nmpop')).toBe(true);
});

test.skipIf(!hasDom)('a phone, trusted folder: a plain Send in the bottom bar, with no circle', async () => {
  await pickStart(true);
  const foot = inDialog('.ib-cp-foot')!;
  expect(foot.querySelector(SEND)!.textContent!.trim()).toBe('Send');
  expect(foot.querySelector(CIRCLE)).toBeNull();
});
