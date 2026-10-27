/**
 * Full screen for files (approval "inbox-one-fullscreen", Drawer): one mode.
 * The pane's Full screen button takes the file to the whole window with one
 * floating toolbar (pen on HTML, the comment count, `N/M ⌄`, ⋯, Side by
 * side, × Exit full screen, » Hide tools); the header, the changed line and
 * the bar under the file are gone, and there is no eye. Hide tucks the toolbar into a corner
 * handle; the corner reveals it; a pin keeps it out. The count opens the
 * comments drawer beside the page, remembered and never opened by itself.
 *
 * What is proved here, on the pane as the thread drives it: the single mode
 * and focus both ways; tuck, reveal and pin, with focus never lost; the
 * corner's timing; the drawer and its remembered state; a new comment only
 * bumping the count; the toolbar always starting out; ⌘⇧X on HTML only; the
 * ⋯ menu; the peek and a step keeping full screen with its chip; Escape's
 * ladder (one thing per press, full screen last; typed words never lost); the changed chip and dot; a phone and a stacked window. The
 * thread's wiring is fullScreenThread.test.tsx; the browser proof is
 * tests/e2e/inbox-full-view.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from the test.yml DOM list.
 */
import { afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAnnotationRecord, InboxAttachmentState, InboxMessageWire } from '@plannotator/core/inbox-types';
import { attachmentSequence, type AttachmentStep } from './stepping';
import { tooltipOf } from './testing/tooltip';

const hasDom = typeof document !== 'undefined';
const { AttachmentPane, COMMENTS_DRAWER_COOKIE } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');
const { REVEAL_DELAY_MS, TUCK_DELAY_MS } = (hasDom ? await import('./components/FullViewBar') : {}) as typeof import('./components/FullViewBar');
const { getShortcutPlatform } = (hasDom ? await import('@plannotator/ui/shortcuts') : {}) as typeof import('@plannotator/ui/shortcuts');
const { storage } = (hasDom ? await import('@plannotator/ui/utils/storage') : {}) as typeof import('@plannotator/ui/utils/storage');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

beforeAll(() => {
  // A page on localhost, as the Inbox is served: about:blank keeps no readable cookies (the drawer's choice is one).
  if (hasDom) (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
});

beforeEach(() => {
  if (hasDom) storage.removeItem(COMMENTS_DRAWER_COOKIE);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
  for (const stray of document.querySelectorAll('[data-test-stray]')) stray.remove();
  if (hasDom) storage.removeItem(COMMENTS_DRAWER_COOKIE);
});

const M1 = 'msg_01K7M1MMMMMMMMMMMMMMMMMMMM';
const M2 = 'msg_01K7M2MMMMMMMMMMMMMMMMMMMM';

function file(id: string, name: string, kind: string, messageId: string, extra: Partial<InboxAttachmentState> = {}): InboxAttachmentState {
  return {
    id,
    name,
    path: `/work/shop/${name}`,
    kind: kind as InboxAttachmentState['kind'],
    named_path: null,
    sent_sha256: 'a'.repeat(64),
    size: 1000,
    sent_at: '2026-10-10T10:42:00.000Z',
    sent_mtime: '2026-10-10T10:42:00.000Z',
    message_id: messageId,
    changed_since_sent: false,
    unavailable: null,
    current: { sha256: 'a'.repeat(64), size: 1000, mtime: '2026-10-10T10:42:00.000Z' },
    ...extra,
  };
}

const notes = file('att_01K7AAAAAAAAAAAAAAAAAAAAAA', 'notes.md', 'markdown', M1);
const page = file('att_01K7BBBBBBBBBBBBBBBBBBBBBB', 'turnkey.html', 'html', M1);
const shot = file('att_01K7CCCCCCCCCCCCCCCCCCCCCC', 'shot.png', 'image', M2, { media_type: 'image/png' });

function message(id: string, createdAt: string): InboxMessageWire {
  return { id, created_at: createdAt, author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude' } } as unknown as InboxMessageWire;
}

const STEPS: AttachmentStep[] = attachmentSequence([message(M1, '2026-10-10T10:42:00.000Z'), message(M2, '2026-10-10T11:06:00.000Z')], [notes, page, shot]);

function record(id: string, att = notes): InboxAnnotationRecord {
  return {
    id,
    attachment_id: att.id,
    path: att.path,
    version: 'current',
    annotation: { id, blockId: 'block-0', startOffset: 0, endOffset: 4, type: 'COMMENT', text: 'Say why.', originalText: 'Plan', createdA: 1 },
  } as unknown as InboxAnnotationRecord;
}
/** One saved comment on notes.md, so the count reads 1. */
const RECORD = record('ann_1');

/** The view route: markdown text, or the HTML page. */
function stubViews() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const att = [notes, page, shot].find((a) => url.includes(a.id));
    if (att && url.includes('/view')) {
      return new Response(
        JSON.stringify({ attachment: att, version: 'current', text: att.kind === 'html' ? '<h1>Checkout</h1>' : '# Plan\n\nShip it.\n', html: att.kind === 'html' ? '<h1>Checkout</h1>' : null }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
}

interface Harness {
  versions: string[];
  reply: number;
  closed: number;
  toggles: number;
  /** Each toggle's `pick`: true for a button (remembered), false for Escape's last rung. */
  picks: boolean[];
  setRecords?: (records: InboxAnnotationRecord[]) => void;
}

/** The pane as the thread drives it: `full` lives in the thread, a step opens the next file in place. */
function Pane({
  start,
  harness,
  startFull = true,
  phone = false,
  locked = false,
  records: initialRecords = [RECORD],
  steps = STEPS,
  version = 'current',
  replyLeaves = false,
}: {
  start: InboxAttachmentState;
  harness: Harness;
  startFull?: boolean;
  phone?: boolean;
  locked?: boolean;
  records?: InboxAnnotationRecord[];
  steps?: AttachmentStep[];
  version?: 'current' | 'sent';
  /** Write the reply leaves full screen, as the thread does. */
  replyLeaves?: boolean;
}) {
  const [open, setOpen] = useState(start);
  const [full, setFull] = useState(startFull);
  const [records, setRecords] = useState(initialRecords);
  harness.setRecords = setRecords;
  const noop = () => {};
  const all = steps.map((s) => s.attachment);
  return (
    <AttachmentPane
      attachment={open}
      attachments={all}
      records={records}
      agent="Claude Code"
      projectName="shop"
      projectRoot="/work/shop"
      version={version}
      onVersion={(v) => harness.versions.push(v)}
      full={full || phone || locked}
      fullLocked={phone || locked}
      onToggleFull={(pick) => {
        harness.toggles++;
        harness.picks.push(pick);
        setFull((v) => !v);
      }}
      focusId={null}
      readOnly={false}
      onSaved={noop}
      onRemoved={noop}
      onOpenAt={noop}
      onClose={() => harness.closed++}
      strip={{
        picks: 0,
        annotations: records.length,
        onWriteReply: () => {
          harness.reply++;
          if (replyLeaves) setFull(false);
        },
      }}
      steps={steps}
      phone={phone}
      onStep={(id) => setOpen(all.find((a) => a.id === id)!)}
    />
  );
}

async function render(node: React.ReactNode) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
  await settle();
}

async function rerender(node: React.ReactNode) {
  act(() => root?.unmount());
  host?.remove();
  await render(node);
}

async function settle(ms = 60) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function key(target: EventTarget, init: KeyboardEventInit): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

const harnessOf = (): Harness => ({ versions: [], reply: 0, closed: 0, toggles: 0, picks: [] });
const pane = () => host!.querySelector<HTMLElement>('[data-attachment-pane]')!;
const dock = () => host!.querySelector<HTMLElement>('[data-full-view-dock]');
const bar = () => host!.querySelector<HTMLElement>('[data-full-view-bar]');
const handle = () => host!.querySelector<HTMLButtonElement>('[data-full-view-handle]')!;
const hideButton = () => host!.querySelector<HTMLButtonElement>('[data-full-view-hide]')!;
const live = () => host!.querySelector('[data-step-live]')!.textContent;
const barState = () => dock()?.getAttribute('data-bar');
const click = async (el: HTMLElement | null) => {
  await act(async () => el!.click());
  await settle();
};
/** A keyboard press on a button: a click whose `detail` is 0. */
const press = async (el: HTMLElement) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
  });
  await settle();
};
/** The platform's own ⌘⇧X. */
const chord = () => (getShortcutPlatform() === 'mac' ? { key: 'X', code: 'KeyX', metaKey: true, shiftKey: true } : { key: 'X', code: 'KeyX', ctrlKey: true, shiftKey: true });
/** The toolbar's controls in order, by their data attribute. */
const controls = () =>
  [...bar()!.querySelectorAll('button')].map((b) =>
    b.hasAttribute('data-full-view-exit') ? `leave:${b.getAttribute('data-full-view-exit')}` : b.hasAttribute('data-full-view-pen') ? 'pen' : b.hasAttribute('data-full-view-comments') ? 'count' : b.hasAttribute('data-full-view-position') ? 'position' : b.hasAttribute('data-full-view-more') ? 'more' : b.hasAttribute('data-full-view-hide') ? `hide:${b.getAttribute('data-full-view-hide')}` : b.hasAttribute('data-full-view-close') ? 'close' : '?',
  );

test.skipIf(!hasDom)('Full screen is one mode: the header, the changed line and the bar under the file go, one toolbar is left; Exit puts the file back beside the thread', async () => {
  stubViews();
  const harness = harnessOf();
  await render(<Pane start={notes} harness={harness} startFull={false} />);
  // Beside the thread: the header's Full screen, the stepper under the file, no eye anywhere.
  // The header's view switch: Side by side pressed, Full screen not.
  const fullButton = host!.querySelector<HTMLButtonElement>('.ib-vhead [data-full-screen-toggle]')!;
  const sideButton = host!.querySelector<HTMLButtonElement>('.ib-vhead [data-view-side]')!;
  expect(fullButton.textContent).toBe('Full screen');
  expect(sideButton.textContent).toBe('Side by side');
  expect(sideButton.getAttribute('aria-pressed')).toBe('true');
  expect(fullButton.getAttribute('aria-pressed')).toBe('false');
  expect(host!.querySelector('[data-view-switch]')!.getAttribute('role')).toBe('group');
  expect(host!.querySelector('[data-html-tools-toggle]')).toBeNull();
  expect(host!.querySelector('[data-view-foot]')).not.toBeNull();
  expect(bar()).toBeNull();

  await click(fullButton);
  expect(harness.toggles).toBe(1);
  expect(pane().classList.contains('ib-full')).toBe(true);
  expect(pane().hasAttribute('data-full-view')).toBe(true);
  expect(host!.querySelector('.ib-vhead')).toBeNull();
  expect(host!.querySelector('[data-view-foot]')).toBeNull();
  expect(host!.querySelector('[data-changed-line]')).toBeNull();
  // The toolbar: a named toolbar, showing, first in the pane; focus on its first button (the header that held Full screen is gone).
  expect(bar()!.getAttribute('role')).toBe('toolbar');
  expect(pane().firstElementChild).toBe(dock());
  expect(barState()).toBe('pinned');
  expect(controls()).toEqual(['count', 'position', 'more', 'leave:exit', 'close', 'hide:hide']);
  expect(document.activeElement).toBe(bar()!.querySelector('button'));
  expect(live()).toBe('Full screen. Side by side is in the toolbar.');
  // The way back is named for where it goes.
  const exit = host!.querySelector<HTMLButtonElement>('[data-full-view-exit="exit"]')!;
  expect(exit.getAttribute('aria-label')).toBe('Side by side');
  expect(exit.textContent).toBe('Side by side');
  // The drawer starts closed (never opened by itself).
  expect(pane().classList.contains('ib-drawer')).toBe(false);

  await click(host!.querySelector('[data-full-view-exit="exit"]'));
  expect(harness.toggles).toBe(2);
  // Both are picks with a button: the host remembers them.
  expect(harness.picks).toEqual([true, true]);
  expect(bar()).toBeNull();
  expect(host!.querySelector('.ib-vhead')).not.toBeNull();
  expect(document.activeElement === host!.querySelector('.ib-vhead [data-view-side]')).toBe(true);
});

test.skipIf(!hasDom)('an HTML file: the pen leads the toolbar and flips Annotate / Interact', async () => {
  stubViews();
  await render(<Pane start={page} harness={harnessOf()} />);
  expect(controls()).toEqual(['pen', 'count', 'position', 'more', 'leave:exit', 'close', 'hide:hide']);
  const pen = host!.querySelector<HTMLButtonElement>('[data-full-view-pen]')!;
  expect(pen.getAttribute('aria-pressed')).toBe('true');
  await click(pen);
  expect(host!.querySelector('[data-full-view-pen]')!.getAttribute('aria-pressed')).toBe('false');
});

test.skipIf(!hasDom)('Hide tucks the toolbar into its handle (inert, focus on the handle); the handle shows it again; the pin keeps it out; Escape tucks a revealed toolbar', async () => {
  stubViews();
  await render(<Pane start={notes} harness={harnessOf()} />);
  hideButton().focus();
  await click(hideButton());
  expect(barState()).toBe('tucked');
  expect(bar()!.inert).toBe(true);
  expect(handle().inert).toBe(false);
  expect(handle().getAttribute('aria-label')).toBe('Show tools, 1 comment');
  expect(handle().getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(handle());
  expect(live()).toBe('Tools hidden. They are in the top right corner.');

  // The keyboard on the handle: revealed, focus on the toolbar's first button; the last button is the pin.
  await press(handle());
  expect(barState()).toBe('revealed');
  expect(bar()!.inert).toBe(false);
  expect(handle().inert).toBe(true);
  expect(document.activeElement).toBe(bar()!.querySelector('button'));
  expect(hideButton().getAttribute('data-full-view-hide')).toBe('pin');
  expect(hideButton().getAttribute('aria-label')).toBe('Keep tools out');

  // Escape (no popover open) tucks it and returns focus to the handle.
  await key(document.activeElement!, { key: 'Escape' });
  expect(barState()).toBe('tucked');
  expect(document.activeElement).toBe(handle());

  // Out again, then the pin: it stays, and the same button is » Hide tools again, focus on it.
  await press(handle());
  hideButton().focus();
  await click(hideButton());
  expect(barState()).toBe('pinned');
  expect(hideButton().getAttribute('aria-label')).toBe('Hide tools');
  expect(document.activeElement).toBe(hideButton());
  expect(live()).toBe('Tools pinned. They stay out.');
});

test.skipIf(!hasDom)('the corner: a pointer reveals the toolbar after its delay and leaving tucks it after its delay; focus leaving or a press outside tucks it too', async () => {
  stubViews();
  await render(<Pane start={notes} harness={harnessOf()} />);
  await click(hideButton());
  // A mouse user: nothing in the corner holds focus.
  (document.activeElement as HTMLElement | null)?.blur();
  const enter = () => act(async () => dock()!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' })));
  const leave = () => act(async () => dock()!.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse', relatedTarget: document.body })));
  await enter();
  expect(barState()).toBe('tucked');
  await settle(REVEAL_DELAY_MS + 60);
  expect(barState()).toBe('revealed');
  await leave();
  await settle(TUCK_DELAY_MS - 200);
  expect(barState()).toBe('revealed');
  await settle(300);
  expect(barState()).toBe('tucked');

  // Revealed, then a press outside the toolbar tucks it.
  await click(handle());
  expect(barState()).toBe('revealed');
  const outside = document.createElement('button');
  outside.setAttribute('data-test-stray', '');
  document.body.appendChild(outside);
  await act(async () => outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  await settle();
  expect(barState()).toBe('tucked');

  // Revealed by the keyboard, then focus leaves: tucked, and focus stays where it went.
  await press(handle());
  expect(barState()).toBe('revealed');
  await act(async () => outside.focus());
  await settle();
  expect(barState()).toBe('tucked');
  expect(document.activeElement).toBe(outside);
});

test.skipIf(!hasDom)('every opening of full screen starts with the toolbar showing', async () => {
  stubViews();
  await render(<Pane start={notes} harness={harnessOf()} startFull={false} />);
  await click(host!.querySelector('[data-full-screen-toggle]'));
  await click(hideButton());
  expect(barState()).toBe('tucked');
  // Leave with the toolbar tucked (its handle shows; Exit is in the toolbar, so reveal it first).
  await press(handle());
  await click(host!.querySelector('[data-full-view-exit]'));
  expect(bar()).toBeNull();
  await click(host!.querySelector('[data-full-screen-toggle]'));
  expect(barState()).toBe('pinned');
  expect(bar()!.inert).toBe(false);
});

test.skipIf(!hasDom)('back into full screen after leaving it tucked (Hide, the drawer, Write the reply): the toolbar is never tucked on entry and focus lands on its first button', async () => {
  stubViews();
  const harness = harnessOf();
  await render(<Pane start={notes} harness={harness} startFull={false} replyLeaves />);
  await click(host!.querySelector('[data-full-screen-toggle]'));
  hideButton().focus();
  await click(hideButton());
  expect(barState()).toBe('tucked');
  // The drawer from the tucked toolbar: the handle brings it out, the count opens the drawer.
  await press(handle());
  await click(host!.querySelector('[data-full-view-comments]'));
  expect(pane().classList.contains('ib-drawer')).toBe(true);
  // Write the reply: a press on the drawer's foot (outside the toolbar, so it tucks) leaves full screen.
  const write = [...host!.querySelectorAll<HTMLButtonElement>('[data-full-view-foot] button')].find((b) => b.textContent === 'Write the reply')!;
  await act(async () => {
    write.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  });
  await click(write);
  expect(harness.reply).toBe(1);
  expect(bar()).toBeNull();

  // Every change to the toolbar's state or inertness from here on is recorded: none may say tucked.
  const seen: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      const el = r.target as Element;
      if (r.attributeName === 'data-bar') seen.push(`data-bar:${r.oldValue}->${el.getAttribute('data-bar')}`);
      if (r.attributeName === 'inert' && el.hasAttribute('data-full-view-bar')) seen.push(`bar-inert:${el.hasAttribute('inert')}`);
    }
  });
  observer.observe(host!, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['data-bar', 'inert'] });
  await click(host!.querySelector('.ib-vhead [data-full-screen-toggle]'));
  observer.disconnect();
  expect(barState()).toBe('pinned');
  expect(bar()!.inert).toBe(false);
  expect(seen.filter((s) => s.includes('tucked') || s === 'bar-inert:true')).toEqual([]);
  expect(document.activeElement).toBe(bar()!.querySelector('button'));
  expect(document.activeElement).not.toBe(document.body);
});

test.skipIf(!hasDom)('the count opens the comments drawer beside the page (it narrows; not covered); its foot says what rides the next Send; Escape and its close shut it, focus back on the count', async () => {
  stubViews();
  const harness = harnessOf();
  await render(<Pane start={notes} harness={harness} records={[RECORD, record('ann_2', page)]} />);
  const count = host!.querySelector<HTMLButtonElement>('[data-full-view-comments]')!;
  expect(count.getAttribute('aria-label')).toBe('Comments, 1');
  expect(count.getAttribute('aria-expanded')).toBe('false');
  await click(count);
  expect(pane().classList.contains('ib-drawer')).toBe(true);
  expect(pane().classList.contains('ib-panel-open')).toBe(false);
  expect(host!.querySelector('[data-comments-drawer]')!.getAttribute('data-comments-drawer')).toBe('open');
  expect(count.getAttribute('aria-expanded')).toBe('true');
  expect(storage.getItem(COMMENTS_DRAWER_COOKIE)).toBe('open');
  // The dock sits left of the drawer.
  expect(dock()!.classList.contains('ib-shift')).toBe(true);
  const foot = host!.querySelector<HTMLElement>('[data-full-view-foot]')!;
  expect(foot.textContent).toContain('2 annotations ride your next Send to Claude Code. 1 is on other files.');
  const buttons = [...foot.querySelectorAll<HTMLButtonElement>('button')];
  expect(buttons.map((b) => b.textContent)).toEqual(['Write the reply']);
  await click(buttons[0]!);
  expect(harness.reply).toBe(1);

  await key(host!.querySelector('.ib-apanel')!, { key: 'Escape' });
  expect(pane().classList.contains('ib-drawer')).toBe(false);
  expect(document.activeElement).toBe(count);
  expect(storage.getItem(COMMENTS_DRAWER_COOKIE)).toBe('closed');
  expect(bar()).not.toBeNull();

  await click(count);
  await click(host!.querySelector('.ib-apanel .ib-sheet-h button'));
  expect(pane().classList.contains('ib-drawer')).toBe(false);
  expect(document.activeElement).toBe(count);
});

test.skipIf(!hasDom)('the drawer remembers being left open; a new comment never opens it and only bumps the count', async () => {
  stubViews();
  const harness = harnessOf();
  await render(<Pane start={notes} harness={harness} />);
  expect(pane().classList.contains('ib-drawer')).toBe(false);
  // A comment saved with the drawer closed: the count bumps, the drawer stays shut.
  await act(async () => harness.setRecords!([RECORD, record('ann_9')]));
  await settle();
  expect(pane().classList.contains('ib-drawer')).toBe(false);
  const count = host!.querySelector<HTMLButtonElement>('[data-full-view-comments]')!;
  expect(count.getAttribute('aria-label')).toBe('Comments, 2');
  expect(count.querySelector('.ib-bump')).not.toBeNull();
  // The handle carries the count too.
  await click(hideButton());
  expect(handle().getAttribute('aria-label')).toBe('Show tools, 2 comments');

  // Left open: the next full screen (another file, another mount) opens with it.
  await press(handle());
  await click(host!.querySelector('[data-full-view-comments]'));
  await rerender(<Pane start={page} harness={harnessOf()} />);
  expect(pane().classList.contains('ib-drawer')).toBe(true);
  // With the toolbar tucked, closing the drawer from inside puts focus on the handle.
  await click(hideButton());
  await click(host!.querySelector('.ib-apanel .ib-sheet-h button'));
  expect(document.activeElement).toBe(handle());
});

test.skipIf(!hasDom)('⌘⇧X on an HTML file tucks and shows the toolbar; on markdown and beside the thread it does nothing; never while typing', async () => {
  stubViews();
  await render(<Pane start={page} harness={harnessOf()} />);
  const event = await key(document.body, chord());
  expect(event.defaultPrevented).toBe(true);
  expect(barState()).toBe('tucked');
  await settle();
  expect(live()).toBe('Tools hidden. They are in the top right corner.');
  await key(document.body, chord());
  expect(barState()).toBe('pinned');
  // The tooltip names the chord on HTML only.
  expect(hideButton().getAttribute('aria-description')).toMatch(/^Shortcut: .+X$/);

  // Typing in a field: the chord is not the toolbar's.
  const field = document.createElement('textarea');
  field.setAttribute('data-test-stray', '');
  document.body.appendChild(field);
  field.focus();
  await key(field, chord());
  expect(barState()).toBe('pinned');

  await rerender(<Pane start={notes} harness={harnessOf()} />);
  const ignored = await key(document.body, chord());
  expect(ignored.defaultPrevented).toBe(false);
  expect(barState()).toBe('pinned');
  expect(hideButton().hasAttribute('aria-description')).toBe(false);

  await rerender(<Pane start={page} harness={harnessOf()} startFull={false} />);
  const beside = await key(document.body, chord());
  expect(beside.defaultPrevented).toBe(false);
  expect(bar()).toBeNull();
});

test.skipIf(!hasDom)('⋯ holds Download and the other version (the changed chip offers it too); the tucked handle carries an amber dot', async () => {
  stubViews();
  // Its own id: the stubbed view route answers the unchanged notes.md, whose record would win.
  const changed = { ...notes, id: 'att_01K7ZZZZZZZZZZZZZZZZZZZZZZ', changed_since_sent: true };
  const harness = harnessOf();
  await render(<Pane start={changed} harness={harness} steps={attachmentSequence([message(M1, '2026-10-10T10:42:00.000Z')], [changed])} />);
  const chip = host!.querySelector<HTMLElement>('[data-full-view-changed]')!;
  expect(chip.querySelector('.ib-fvver-t')!.textContent).toBe('Changed since sent');
  expect(chip.querySelector('button')!.textContent).toBe('Open the version it sent');
  expect(await tooltipOf(chip)).toMatch(/^Changed since Claude Code sent it at /);

  const more = host!.querySelector<HTMLButtonElement>('[data-full-view-more]')!;
  expect(more.getAttribute('aria-label')).toBe('More: download, versions');
  await click(more);
  const menu = document.querySelector<HTMLElement>(`[data-full-view-menu="${changed.id}"]`)!;
  expect(menu).not.toBeNull();
  expect(menu.querySelector<HTMLAnchorElement>('[data-attachment-download]')!.getAttribute('href')).toContain(changed.id);
  await click(menu.querySelector<HTMLElement>('[data-full-view-version]'));
  expect(harness.versions).toEqual(['sent']);

  // The changed chip is a fact about the file: it stays when the toolbar tucks, and the handle says so.
  await click(hideButton());
  expect(host!.querySelector('[data-full-view-changed]')).not.toBeNull();
  expect(handle().querySelector('.ib-fvhandle-dot')).not.toBeNull();
  expect(handle().getAttribute('aria-label')).toBe('Show tools, 1 comment, file changed since sent');

  // Beside the thread the changed line, not the chip.
  await rerender(<Pane start={changed} harness={harnessOf()} startFull={false} />);
  expect(host!.querySelector('[data-full-view-changed]')).toBeNull();
  expect(host!.querySelector('[data-changed-line]')).not.toBeNull();
});

test.skipIf(!hasDom)('N/M opens the file peek under the toolbar; a pick steps there and full screen stays', async () => {
  stubViews();
  await render(<Pane start={notes} harness={harnessOf()} />);
  const pos = host!.querySelector<HTMLButtonElement>('[data-full-view-position]')!;
  expect(pos.textContent).toBe('1/3');
  expect(pos.getAttribute('aria-label')).toBe('1 of 3, notes.md. Show every file in this thread');
  await click(pos);
  expect(pos.getAttribute('aria-expanded')).toBe('true');
  const peek = bar()!.querySelector<HTMLElement>('[data-step-list] [role="grid"]');
  expect(peek).not.toBeNull();
  const tile = [...peek!.querySelectorAll<HTMLElement>('[role="gridcell"], button')].find((el) => el.textContent?.includes('shot.png'));
  await click(tile!);
  expect(pane().getAttribute('data-attachment-pane')).toBe(shot.id);
  expect(bar()).not.toBeNull();
  expect(pos.getAttribute('aria-expanded')).toBe('false');
});

test.skipIf(!hasDom)('a step keeps full screen and the toolbar as it was: the chip names the new file for a moment, and "Last file in this thread" at the end', async () => {
  stubViews();
  await render(<Pane start={page} harness={harnessOf()} />);
  await click(hideButton());
  const chip = () => host!.querySelector<HTMLElement>('[data-full-view-chip]')!;
  expect(chip().getAttribute('data-full-view-chip')).toBe('hidden');
  await key(pane(), { key: ']' });
  expect(pane().getAttribute('data-attachment-pane')).toBe(shot.id);
  expect(barState()).toBe('tucked');
  expect(chip().getAttribute('data-full-view-chip')).toBe('shown');
  expect(chip().textContent).toContain('3 of 3');
  expect(chip().textContent).toContain('shot.png');
  await key(pane(), { key: ']' });
  expect(chip().textContent).toContain('Last file in this thread');
  await settle(1700);
  expect(chip().getAttribute('data-full-view-chip')).toBe('hidden');
});

/** Type into a React-controlled field the way the browser does (the value setter, then an input event). */
async function typeInto(area: HTMLTextAreaElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, text);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
/** A stand-in comment popover (Plannotator's draws in a portal on the page), counting the Escapes that reach it. */
function strayComposer(text: string) {
  const box = document.createElement('div');
  box.setAttribute('data-comment-popover', 'true');
  box.setAttribute('data-test-stray', '');
  const area = document.createElement('textarea');
  area.value = text;
  box.appendChild(area);
  document.body.appendChild(box);
  const reached = { escapes: 0 };
  area.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') reached.escapes++;
  });
  return { box, area, reached };
}
const guardRow = () => host!.querySelector<HTMLElement>('[data-step-guard]');
const guardLabels = () => [...guardRow()!.querySelectorAll('button')].map((b) => b.textContent);
const escapeOn = async (target: EventTarget) => {
  const event = await key(target, { key: 'Escape' });
  await settle();
  return event;
};

/** Where leaving full screen left things: the pane, focus, what was said, and whether it was a pick. */
const afterLeaving = (harness: Harness) => ({
  full: bar() !== null,
  toggles: harness.toggles,
  picks: harness.picks,
  focusOnSwitch: document.activeElement === host!.querySelector('.ib-vhead [data-view-side]'),
  said: live(),
});

for (const [kind, start] of [['markdown', notes], ['HTML', page], ['image', shot]] as const) {
  test.skipIf(!hasDom)(`${kind}: × Exit full screen, just before », leaves full screen as Escape's last step does (not a pick; focus back on the view switch)`, async () => {
    stubViews();
    // Escape's last step, from the pane with nothing else open.
    const byEscape = harnessOf();
    await render(<Pane start={start} harness={byEscape} />);
    pane().focus();
    await escapeOn(pane());
    // HTML starts in Annotate: Escape's first press takes it to Interact.
    if (byEscape.toggles === 0) await escapeOn(pane());
    const escaped = afterLeaving(byEscape);
    expect(escaped).toEqual({ full: false, toggles: 1, picks: [false], focusOnSwitch: true, said: 'Side by side: the file is beside the thread.' });

    // The button, entered the way a person does: the header's Full screen.
    const byButton = harnessOf();
    await rerender(<Pane start={start} harness={byButton} startFull={false} />);
    await click(host!.querySelector('.ib-vhead [data-full-screen-toggle]'));
    // » keeps the corner; × sits just before it.
    expect(controls().slice(-2)).toEqual(['close', 'hide:hide']);
    const close = host!.querySelector<HTMLButtonElement>('[data-full-view-close]')!;
    expect(close.getAttribute('aria-label')).toBe('Exit full screen');
    expect(close.getAttribute('aria-keyshortcuts')).toBe('Escape');
    // An icon button: no words beside the ×; the component tooltip names it and shows Esc as a keycap.
    expect(close.textContent).toBe('');
    expect(close.hasAttribute('title')).toBe(false);
    expect(await tooltipOf(close)).toBe('Exit full screenEsc');
    expect([...document.querySelectorAll('kbd')].map((k) => k.textContent)).toContain('Esc');

    await click(close);
    // The entry was a pick (the header's Full screen); the way out is not, as with Escape.
    expect({ ...afterLeaving(byButton), picks: byButton.picks.slice(1), toggles: byButton.toggles - 1 }).toEqual(escaped);
    expect(host!.querySelector('[data-full-view-close]')).toBeNull();
  });
}

test.skipIf(!hasDom)('one Escape with focus on × leaves full screen: its tooltip, opened by that focus, does not keep the press', async () => {
  stubViews();
  const harness = harnessOf();
  await render(<Pane start={notes} harness={harness} />);
  const close = host!.querySelector<HTMLButtonElement>('[data-full-view-close]')!;
  await act(async () => close.focus());
  // Its tooltip is open, as a pointer resting there leaves it.
  expect(await tooltipOf(close)).toBe('Exit full screenEsc');
  await escapeOn(close);
  expect(harness.toggles).toBe(1);
  expect(harness.picks).toEqual([false]);
  expect(bar()).toBeNull();
});

test.skipIf(!hasDom)('Escape closes one thing per press, innermost first, then leaves full screen (markdown): the file list, the drawer, then the file goes back beside the thread', async () => {
  stubViews();
  const harness = harnessOf();
  await render(<Pane start={notes} harness={harness} />);
  // The file list: Escape inside it closes it and focus goes back to N/M (its own key); full screen stays.
  const pos = host!.querySelector<HTMLButtonElement>('[data-full-view-position]')!;
  await click(pos);
  await escapeOn(document.activeElement ?? pos);
  expect(pos.getAttribute('aria-expanded')).toBe('false');
  expect(harness.toggles).toBe(0);
  // Open again, focus elsewhere: the ladder closes it first.
  await click(pos);
  pane().focus();
  await escapeOn(pane());
  expect(pos.getAttribute('aria-expanded')).toBe('false');
  expect(harness.toggles).toBe(0);
  // The drawer: closes, focus on the count, said.
  await click(host!.querySelector('[data-full-view-comments]'));
  expect(pane().classList.contains('ib-drawer')).toBe(true);
  pane().focus();
  await escapeOn(pane());
  expect(pane().classList.contains('ib-drawer')).toBe(false);
  expect(document.activeElement).toBe(host!.querySelector('[data-full-view-comments]'));
  expect(live()).toBe('Comments closed.');
  expect(harness.toggles).toBe(0);
  // Nothing left: full screen ends, the file is beside the thread, focus on the switch's Side by side.
  await escapeOn(document.activeElement!);
  // The count's tooltip, opened by that focus, takes a press of its own first (it is the innermost thing open).
  if (harness.toggles === 0) await escapeOn(document.activeElement!);
  expect(harness.toggles).toBe(1);
  expect(bar()).toBeNull();
  // Escape's last rung is not a pick: nothing is remembered.
  expect(harness.picks).toEqual([false]);
  expect(document.activeElement === host!.querySelector('.ib-vhead [data-view-side]')).toBe(true);
  expect(live()).toBe('Side by side: the file is beside the thread.');
  // Beside the thread there is no ladder.
  await escapeOn(pane());
  expect(harness.toggles).toBe(1);
});

test.skipIf(!hasDom)('HTML: Escape takes the drawer, then Annotate to Interact, then leaves; from inside the page too (annotate-exit, then an Escape the page did not use)', async () => {
  stubViews();
  const harness = harnessOf();
  await render(<Pane start={page} harness={harness} />);
  const pen = () => host!.querySelector<HTMLButtonElement>('[data-full-view-pen]')!;
  expect(pen().getAttribute('aria-pressed')).toBe('true');
  // From the window.
  await click(host!.querySelector('[data-full-view-comments]'));
  pane().focus();
  await escapeOn(pane());
  expect(pane().classList.contains('ib-drawer')).toBe(false);
  expect(pen().getAttribute('aria-pressed')).toBe('true');
  pane().focus();
  const toInteract = await escapeOn(pane());
  // Used: the HTML viewer's own Annotate rung (a window listener) does not take a second step.
  expect(toInteract.defaultPrevented).toBe(true);
  expect(pen().getAttribute('aria-pressed')).toBe('false');
  expect(live()).toBe('Interact: clicks reach the page.');
  expect(harness.toggles).toBe(0);
  await click(pen());

  // From inside the page: the bridge's messages.
  const iframe = host!.querySelector<HTMLIFrameElement>('iframe')!;
  const post = async (type: string) => {
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { source: iframe.contentWindow, data: { type } }));
    });
    await settle();
  };
  await click(host!.querySelector('[data-full-view-comments]'));
  await post('plannotator-bridge-annotate-exit');
  expect(pane().classList.contains('ib-drawer')).toBe(false);
  expect(pen().getAttribute('aria-pressed')).toBe('true');
  await post('plannotator-bridge-annotate-exit');
  expect(pen().getAttribute('aria-pressed')).toBe('false');
  expect(harness.toggles).toBe(0);
  await act(async () => iframe.focus());
  await post('plannotator-bridge-page-escape');
  expect(harness.toggles).toBe(1);
});

test.skipIf(!hasDom)('a comment with typed words is never lost by Escape: the question asks (Save it, Discard it, Keep writing); an empty one just closes; neither leaves full screen', async () => {
  stubViews();
  const harness = harnessOf();
  await render(<Pane start={notes} harness={harness} />);
  const { box, area, reached } = strayComposer('Say why the flag stays.');
  area.focus();
  const asked = await escapeOn(area);
  // The composer never saw the key (it would have closed and dropped the words).
  expect(reached.escapes).toBe(0);
  expect(asked.defaultPrevented).toBe(true);
  expect(guardLabels()).toEqual(['Save it', 'Discard it', 'Keep writing']);
  expect(document.activeElement).toBe(guardRow()!.querySelector('[data-guard-save]'));
  // Keep writing: back in the words.
  await click(guardRow()!.querySelector('[data-guard-keep]'));
  expect(guardRow()).toBeNull();
  expect(document.activeElement).toBe(area);
  // Asked again, then Discard: the composer gets its own Escape (once), and full screen stays.
  await escapeOn(area);
  await click(guardRow()!.querySelector('[data-guard-discard]'));
  expect(reached.escapes).toBe(1);
  expect(live()).toBe('Comment discarded.');
  expect(harness.toggles).toBe(0);
  expect(bar()).not.toBeNull();
  // Empty, with focus elsewhere: the ladder closes it (one Escape sent to it), nothing more.
  await typeInto(area, '');
  pane().focus();
  await escapeOn(pane());
  expect(reached.escapes).toBe(2);
  expect(live()).toBe('Comment closed.');
  expect(harness.toggles).toBe(0);
  box.remove();
  await escapeOn(pane());
  expect(harness.toggles).toBe(1);
});

test.skipIf(!hasDom)('an image: Escape leaves its comment row with the words kept, then leaves full screen; where the file can only be full screen, leaving asks about the words first', async () => {
  stubViews();
  const harness = harnessOf();
  await render(<Pane start={shot} harness={harness} />);
  const row = () => host!.querySelector<HTMLTextAreaElement>('[data-image-composer] textarea')!;
  await typeInto(row(), 'Crop the header.');
  row().focus();
  await escapeOn(row());
  expect(document.activeElement).toBe(pane());
  expect(row().value).toBe('Crop the header.');
  expect(live()).toBe('Left the comment box.');
  expect(harness.toggles).toBe(0);
  await escapeOn(pane());
  expect(harness.toggles).toBe(1);
  expect(row().value).toBe('Crop the header.');

  // A stacked window: the last rung goes back to the thread, through the unsaved-comment question.
  const locked = harnessOf();
  await rerender(<Pane start={shot} harness={locked} locked />);
  await typeInto(row(), 'Crop the header.');
  row().focus();
  await escapeOn(row());
  await escapeOn(pane());
  expect(locked.closed).toBe(0);
  expect(guardLabels()).toEqual(['Save it and close', 'Discard and close the file', 'Keep writing']);
  await click(guardRow()!.querySelector('[data-guard-discard]'));
  expect(locked.closed).toBe(1);
});

test.skipIf(!hasDom)('Escape is not the ladder’s under a dialog, while a selection toolbar closes itself, or in a text field', async () => {
  stubViews();
  const harness = harnessOf();
  await render(<Pane start={notes} harness={harness} />);
  const dialog = document.createElement('dialog');
  dialog.setAttribute('open', '');
  dialog.setAttribute('data-test-stray', '');
  document.body.appendChild(dialog);
  await escapeOn(pane());
  expect(harness.toggles).toBe(0);
  dialog.remove();
  const toolbar = document.createElement('div');
  toolbar.setAttribute('data-pn-annotation-toolbar-row', 'true');
  toolbar.setAttribute('data-test-stray', '');
  document.body.appendChild(toolbar);
  await escapeOn(pane());
  expect(harness.toggles).toBe(0);
  toolbar.remove();
  const field = document.createElement('input');
  field.setAttribute('data-test-stray', '');
  document.body.appendChild(field);
  await escapeOn(field);
  expect(harness.toggles).toBe(0);
  await escapeOn(pane());
  expect(harness.toggles).toBe(1);
});

test.skipIf(!hasDom)('a press outside closes the peek from the toolbar without pulling focus back to N/M', async () => {
  stubViews();
  await render(<Pane start={notes} harness={harnessOf()} />);
  const pos = host!.querySelector<HTMLButtonElement>('[data-full-view-position]')!;
  await click(pos);
  expect(pos.getAttribute('aria-expanded')).toBe('true');
  const outside = document.createElement('button');
  outside.setAttribute('data-test-stray', '');
  document.body.appendChild(outside);
  await act(async () => {
    outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    outside.focus();
  });
  await settle();
  expect(pos.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(outside);
});

test.skipIf(!hasDom)('a one-file thread: the chip names the file once as full screen starts, and there is no N/M', async () => {
  stubViews();
  await render(<Pane start={page} harness={harnessOf()} steps={attachmentSequence([message(M1, '2026-10-10T10:42:00.000Z')], [page])} />);
  const chip = host!.querySelector<HTMLElement>('[data-full-view-chip]')!;
  expect(chip.getAttribute('data-full-view-chip')).toBe('shown');
  expect(chip.textContent).toBe('turnkey.html');
  expect(host!.querySelector('[data-full-view-position]')).toBeNull();
});

test.skipIf(!hasDom)('a phone: the same mode; ‹ Back to the thread leads (44 px), the 2/3 pill and no Exit; the count opens the bottom sheet, whose foot holds the position too; ⋯ no longer lists the files', async () => {
  stubViews();
  const harness = harnessOf();
  await render(<Pane start={page} harness={harness} phone />);
  expect(dock()!.classList.contains('ib-fvdock-phone')).toBe(true);
  expect(controls()).toEqual(['leave:back', 'pen', 'count', 'position', 'more', 'hide:hide']);
  // No corner on a phone: the handle is tapped.
  expect(host!.querySelector('.ib-fvzone')).toBeNull();
  await click(host!.querySelector('[data-full-view-comments]'));
  expect(pane().classList.contains('ib-panel-open')).toBe(true);
  expect(pane().classList.contains('ib-drawer')).toBe(false);
  const pos = host!.querySelector<HTMLButtonElement>('[data-full-view-foot] [data-full-view-position]')!;
  expect(pos.textContent).toContain('2 of 3');
  await click(pos);
  // The peek is the phone's bottom sheet, drawn in the Inbox's root.
  expect(document.querySelector('.pn-inbox-peek [role="grid"]')).not.toBeNull();
  await act(async () => document.querySelector<HTMLElement>('.pn-inbox-peek [role="grid"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await settle();

  // ⋯ on a phone holds Open in, Download and the versions only: the files are the pill's (phoneStepping.test.tsx).
  await click(host!.querySelector('[data-full-view-more]'));
  expect(document.querySelector('[data-full-view-menu-position]')).toBeNull();
  await act(async () => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await settle();

  // ‹ goes back to the thread.
  await click(host!.querySelector('[data-full-view-exit="back"]'));
  expect(harness.closed).toBe(1);
});

test.skipIf(!hasDom)('a window too narrow for the file beside the thread (stacked): Back to the thread leads the toolbar, with no Exit; the drawer still docks', async () => {
  stubViews();
  const harness = harnessOf();
  await render(<Pane start={notes} harness={harness} locked />);
  expect(controls()).toEqual(['leave:back', 'count', 'position', 'more', 'hide:hide']);
  await click(host!.querySelector('[data-full-view-comments]'));
  expect(pane().classList.contains('ib-drawer')).toBe(true);
  await click(host!.querySelector('[data-full-view-exit="back"]'));
  expect(harness.closed).toBe(1);
});
