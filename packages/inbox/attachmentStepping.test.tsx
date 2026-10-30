/**
 * Stepping through a thread's attachments without leaving the viewer (design
 * record "inbox-attachment-stepping", v2, not in this repo): the order across
 * messages, the stops at the ends, when `]` `[` `→` `←` stand down, the
 * question row before a typed comment is lost, the header's name rule, the
 * live region, and the image comment box starting empty on every file. The
 * real browser proof (the HTML bridge, Back, the list) is
 * tests/e2e/inbox-attachment-stepping.spec.ts.
 *
 * DOM-gated: the rendering tests run under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachmentState, InboxMessageWire } from '@plannotator/core/inbox-types';
import { attachmentSequence, stepAnnouncement, type AttachmentStep } from './stepping';

const hasDom = typeof document !== 'undefined';
const { AttachmentPane } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
  if (hasDom) window.getSelection()?.removeAllRanges();
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

const shotA = file('att_01K7AAAAAAAAAAAAAAAAAAAAAA', 'desktop.png', 'image', M1, { media_type: 'image/png' });
const spec = file('att_01K7BBBBBBBBBBBBBBBBBBBBBB', 'refund-policy.pdf', 'pdf', M1, { media_type: 'application/pdf' });
const shotB = file('att_01K7CCCCCCCCCCCCCCCCCCCCCC', 'checkout-mobile.png', 'image', M2, { media_type: 'image/png', changed_since_sent: true });
const zip = file('att_01K7DDDDDDDDDDDDDDDDDDDDDD', 'fixtures.zip', 'file', M2);

function message(id: string, createdAt: string): InboxMessageWire {
  return { id, created_at: createdAt, author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude' } } as unknown as InboxMessageWire;
}

// The model lists files in any order; the thread's order is message by message.
const STEPS: AttachmentStep[] = attachmentSequence(
  [message(M1, '2026-10-10T10:42:00.000Z'), message(M2, '2026-10-10T11:06:00.000Z')],
  [shotB, shotA, zip, spec],
);

test('the sequence is every attachment in thread order: message by message, tiles in their order', () => {
  expect(STEPS.map((s) => s.attachment.name)).toEqual(['desktop.png', 'refund-policy.pdf', 'checkout-mobile.png', 'fixtures.zip']);
  expect(STEPS.map((s) => s.messageId)).toEqual([M1, M1, M2, M2]);
  // A file whose message is not in the thread still counts, last.
  const stray = file('att_01K7EEEEEEEEEEEEEEEEEEEEEE', 'stray.md', 'markdown', 'msg_gone');
  expect(attachmentSequence([message(M1, '2026-10-10T10:42:00.000Z')], [stray, shotA]).map((s) => s.attachment.name)).toEqual(['desktop.png', 'stray.md']);
});

test('a step announces position, name, kind, a change, and the message it came in', () => {
  expect(stepAnnouncement(STEPS, 2)).toMatch(/^3 of 4, checkout-mobile\.png, PNG image, changed since it was sent, attached to Claude's (?:[A-Z][a-z]{2} \d{1,2}, (?:\d{4}, )?)?\d{1,2}:\d{2} [AP]M message$/);
  expect(stepAnnouncement(STEPS, 1)).toMatch(/^2 of 4, refund-policy\.pdf, PDF, attached to Claude's /);
});

interface Harness {
  steps: { id: string; version: string }[];
  closed: number;
  saved: object[];
}

/** The pane as the thread drives it: a step opens the next file in place. */
function Pane({ start, full = false, harness, steps = STEPS, phone = false }: { start: InboxAttachmentState; full?: boolean; harness: Harness; steps?: AttachmentStep[]; phone?: boolean }) {
  const [open, setOpen] = useState(start);
  const noop = () => {};
  const all = steps.map((s) => s.attachment);
  return (
    <AttachmentPane
      attachment={open}
      attachments={all}
      records={[]}
      agent="Claude"
      projectName="shop"
      projectRoot="/work/shop"
      version="current"
      onVersion={noop}
      full={full || phone}
      fullLocked={phone}
      onToggleFull={noop}
      focusId={null}
      readOnly={false}
      onSaved={noop}
      onRemoved={noop}
      onOpenAt={noop}
      onClose={() => harness.closed++}
      strip={{ picks: 0, annotations: 0, onWriteReply: noop }}
      steps={steps}
      phone={phone}
      onStep={(id, version) => {
        harness.steps.push({ id, version });
        setOpen(all.find((a) => a.id === id)!);
      }}
    />
  );
}

async function render(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
}

const pane = () => host!.querySelector<HTMLElement>('[data-attachment-pane]')!;
const openId = () => pane().getAttribute('data-attachment-pane');
const harnessOf = (): Harness => ({ steps: [], closed: 0, saved: [] });

/** A keydown as the browser sends it, from `target`. */
async function key(target: EventTarget, init: KeyboardEventInit): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

test.skipIf(!hasDom)('] and [ step through the thread in order and stop at the ends with a note; the live region says where you are', async () => {
  const harness = harnessOf();
  await render(<Pane start={shotA} harness={harness} />);
  expect(host!.querySelector('[data-step-label]')!.getAttribute('aria-label')).toBe('1 of 4, desktop.png. Show every file in this thread');
  const prev = host!.querySelector<HTMLButtonElement>('[data-step-prev]')!;
  expect(prev.getAttribute('aria-disabled')).toBe('true');
  expect(prev.getAttribute('aria-label')).toBe('Previous file');
  expect(host!.querySelector('[data-step-next]')!.getAttribute('aria-label')).toBe('Next file: refund-policy.pdf');

  // [ at the first file: no step, the note.
  await key(pane(), { key: '[' });
  expect(harness.steps).toEqual([]);
  expect(host!.querySelector('[data-step-end-note]')!.textContent).toBe('First file in this thread');

  for (const expected of [spec, shotB, zip]) {
    await key(pane(), { key: ']' });
    expect(openId()).toBe(expected.id);
  }
  // Across messages: the message it came in is announced.
  await settle();
  expect(host!.querySelector('[data-step-live]')!.textContent).toMatch(/^4 of 4, fixtures\.zip, ZIP file, attached to Claude's /);
  expect(pane().getAttribute('aria-label')).toBe('fixtures.zip, file 4 of 4');
  // The end: › greys with aria-disabled (focusable), ] stops, and the note says so.
  const next = host!.querySelector<HTMLButtonElement>('[data-step-next]')!;
  expect(next.getAttribute('aria-disabled')).toBe('true');
  expect(next.disabled).toBe(false);
  expect(next.getAttribute('aria-label')).toBe('Next file');
  await act(async () => next.click());
  expect(openId()).toBe(zip.id);
  expect(harness.steps).toHaveLength(3);
  expect(host!.querySelector('[data-step-end-note]')!.textContent).toBe('Last file in this thread');
  await settle();
  expect(host!.querySelector('[data-step-live]')!.textContent).toBe('Last file in this thread');
  // ← goes back.
  await key(pane(), { key: 'ArrowLeft' });
  expect(openId()).toBe(shotB.id);
});

test.skipIf(!hasDom)('the keys stand down: while typing, with a modifier, on repeat, mid-composition, Shift with an arrow, a selection, an arrow owner', async () => {
  const harness = harnessOf();
  await render(<Pane start={spec} harness={harness} />);
  // Typing in a field: [ ] and the arrows are text.
  const field = document.createElement('textarea');
  pane().appendChild(field);
  for (const k of [']', '[', 'ArrowRight']) await key(field, { key: k });
  const input = document.createElement('input');
  pane().appendChild(input);
  await key(input, { key: ']' });
  const editable = document.createElement('div');
  editable.contentEditable = 'true';
  pane().appendChild(editable);
  await key(editable, { key: ']' });
  // ⌘ / Ctrl / Alt: the browser's Back and Forward.
  await key(pane(), { key: ']', metaKey: true });
  await key(pane(), { key: ']', ctrlKey: true });
  await key(pane(), { key: ']', altKey: true });
  await key(pane(), { key: 'ArrowRight', altKey: true });
  // Holding the key steps once, not again on repeat; an IME composition is text.
  await key(pane(), { key: ']', repeat: true });
  await key(pane(), { key: ']', isComposing: true });
  // Shift extends a selection.
  await key(pane(), { key: 'ArrowRight', shiftKey: true });
  // The diagram canvas pans with arrows (] still steps from it).
  const canvas = document.createElement('div');
  canvas.setAttribute('data-diagram-canvas', '');
  canvas.tabIndex = 0;
  pane().appendChild(canvas);
  await key(canvas, { key: 'ArrowRight' });
  // A menu, a listbox, a tab list keep their arrows.
  for (const role of ['menu', 'listbox', 'tablist', 'radiogroup', 'slider']) {
    const owner = document.createElement('div');
    owner.setAttribute('role', role);
    const inner = document.createElement('button');
    owner.appendChild(inner);
    pane().appendChild(owner);
    await key(inner, { key: 'ArrowRight' });
  }
  // A handler already used the arrow.
  const used = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
  used.preventDefault();
  await act(async () => {
    pane().dispatchEvent(used);
  });
  // A text selection in the document: the arrows are the person's.
  const text = document.createElement('p');
  text.textContent = 'Partial refunds are in for v1.';
  pane().appendChild(text);
  const range = document.createRange();
  range.selectNodeContents(text);
  window.getSelection()!.addRange(range);
  await key(pane(), { key: 'ArrowRight' });
  window.getSelection()!.removeAllRanges();
  expect(harness.steps).toEqual([]);

  // None of that held: ] from the diagram canvas steps, and a plain → steps.
  await key(canvas, { key: ']' });
  expect(harness.steps.map((s) => s.id)).toEqual([shotB.id]);
  await key(pane(), { key: 'ArrowRight' });
  expect(harness.steps.map((s) => s.id)).toEqual([shotB.id, zip.id]);
});

test.skipIf(!hasDom)('a zoomed image never keeps the arrows: → and ] step from the focused stage at Actual size and zoomed; ↓ pans it', async () => {
  // happy-dom answers a relative src with an error on about:blank: give the page an address.
  const happy = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;
  const was = location.href;
  happy.setURL('http://localhost:4000/');
  try {
    const harness = harnessOf();
    await render(<Pane start={shotA} harness={harness} />);
    const loadStage = async () => {
      const stage = host!.querySelector<HTMLElement>('[data-image-zoom-stage]')!;
      stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, x: 0, y: 0, toJSON() {} }) as DOMRect;
      const img = stage.querySelector<HTMLImageElement>('[data-lightbox-image]')!;
      Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 2000 });
      Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 1500 });
      await act(async () => {
        img.dispatchEvent(new Event('load'));
      });
      return { stage, img };
    };
    const { stage, img } = await loadStage();
    // Actual size: the image is far larger than the stage, and nothing claims the arrows.
    await act(async () => host!.querySelector<HTMLButtonElement>('[data-image-fit]')!.click());
    expect(host!.querySelector('[data-claims-arrows]')).toBeNull();
    stage.focus();
    const before = img.style.transform;
    const down = await key(stage, { key: 'ArrowDown' });
    expect(down.defaultPrevented).toBe(true);
    expect(img.style.transform).not.toBe(before);
    expect(harness.steps).toEqual([]);
    await key(stage, { key: 'ArrowRight' });
    expect(harness.steps.map((s) => s.id)).toEqual([spec.id]);
    // Back on the image, zoomed by a pinch: → still steps.
    await key(pane(), { key: '[' });
    expect(openId()).toBe(shotA.id);
    const again = await loadStage();
    const wheel = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
    Object.defineProperty(wheel, 'ctrlKey', { value: true });
    Object.defineProperty(wheel, 'clientX', { value: 500 });
    Object.defineProperty(wheel, 'clientY', { value: 300 });
    await act(async () => {
      again.stage.dispatchEvent(wheel);
    });
    expect(again.stage.getAttribute('data-image-zoom-stage')).toBe('zoom');
    again.stage.focus();
    await key(again.stage, { key: 'ArrowRight' });
    expect(openId()).toBe(spec.id);
  } finally {
    happy.setURL(was);
  }
});

test.skipIf(!hasDom)('beside the thread, keys step only from inside the file; full screen, from anywhere', async () => {
  const harness = harnessOf();
  await render(<Pane start={shotA} harness={harness} full={false} />);
  const outside = document.createElement('button');
  document.body.appendChild(outside);
  try {
    await key(outside, { key: ']' });
    expect(harness.steps).toEqual([]);
    await key(pane(), { key: ']' });
    expect(harness.steps).toHaveLength(1);
  } finally {
    outside.remove();
  }
});

test.skipIf(!hasDom)('the peek opens a picture list, one row per message; it owns the keys while open (← → ↑ ↓ Home End), Enter opens a file and focus returns to the pill, Esc and Tab close it', async () => {
  const harness = harnessOf();
  await render(<Pane start={shotA} harness={harness} />);
  const labelButton = host!.querySelector<HTMLButtonElement>('[data-step-label]')!;
  expect(labelButton.getAttribute('aria-haspopup')).toBe('grid');
  await act(async () => labelButton.click());
  const peek = host!.querySelector<HTMLElement>('[role="grid"]')!;
  expect(labelButton.getAttribute('aria-expanded')).toBe('true');
  expect(labelButton.getAttribute('aria-controls')).toBe(peek.id);
  expect([...peek.querySelectorAll('[role="gridcell"]')].map((i) => i.getAttribute('data-peek-item'))).toEqual(STEPS.map((s) => s.attachment.id));
  // One row per message, each labelled by its time.
  expect(peek.querySelectorAll('[role="row"]')).toHaveLength(2);
  expect(peek.querySelectorAll('[role="rowheader"]')[0]!.textContent).toMatch(/\d{1,2}:\d{2} [AP]M/);
  // The open file is ringed; images have thumbnails, other files type tiles; attached files a paperclip.
  expect(peek.querySelector('[aria-selected="true"]')!.getAttribute('data-peek-item')).toBe(shotA.id);
  expect(peek.querySelector(`[data-peek-item="${shotA.id}"] img`)!.getAttribute('src')).toBe(`/api/inbox/attachments/${shotA.id}/image`);
  expect(peek.querySelector(`[data-peek-item="${spec.id}"]`)!.textContent).toContain('PDF');
  expect(peek.querySelectorAll('[data-peek-attached]')).toHaveLength(4);
  // The open file's cell has focus; ] does not step under the peek.
  expect(document.activeElement?.getAttribute('data-peek-item')).toBe(shotA.id);
  await key(pane(), { key: ']' });
  expect(harness.steps).toEqual([]);
  await key(document.activeElement!, { key: 'ArrowRight' });
  expect(document.activeElement?.getAttribute('data-peek-item')).toBe(spec.id);
  await key(document.activeElement!, { key: 'ArrowDown' });
  expect(document.activeElement?.getAttribute('data-peek-item')).toBe(zip.id);
  await key(document.activeElement!, { key: 'ArrowUp' });
  expect(document.activeElement?.getAttribute('data-peek-item')).toBe(spec.id);
  await key(document.activeElement!, { key: 'End' });
  expect(document.activeElement?.getAttribute('data-peek-item')).toBe(zip.id);
  await key(document.activeElement!, { key: 'Home' });
  expect(document.activeElement?.getAttribute('data-peek-item')).toBe(shotA.id);
  await key(document.activeElement!, { key: 'End' });
  await key(document.activeElement!, { key: 'Enter' });
  expect(openId()).toBe(zip.id);
  expect(host!.querySelector('[role="grid"]')).toBeNull();
  expect(document.activeElement).toBe(host!.querySelector('[data-step-label]'));
  // ↓ on the pill opens it; Escape closes it and hands focus back to the pill.
  await key(host!.querySelector('[data-step-label]')!, { key: 'ArrowDown' });
  expect(host!.querySelector('[role="grid"]')).not.toBeNull();
  await key(document.activeElement!, { key: 'Escape' });
  expect(host!.querySelector('[role="grid"]')).toBeNull();
  expect(document.activeElement).toBe(host!.querySelector('[data-step-label]'));
  // Tab closes it too.
  await act(async () => host!.querySelector<HTMLButtonElement>('[data-step-label]')!.click());
  await key(document.activeElement!, { key: 'Tab' });
  expect(host!.querySelector('[role="grid"]')).toBeNull();
  // A click on a picture opens it.
  await act(async () => host!.querySelector<HTMLButtonElement>('[data-step-label]')!.click());
  await act(async () => host!.querySelector<HTMLElement>(`[data-peek-item="${shotB.id}"]`)!.click());
  expect(openId()).toBe(shotB.id);
});

test.skipIf(!hasDom)('on a phone (always full screen) the position in the comments sheet opens the peek as a bottom sheet, three across; the backdrop closes it and focus returns to the position', async () => {
  await render(<Pane start={shotA} harness={harnessOf()} phone />);
  // No stepper under the file on a phone: the toolbar and its comments sheet carry the position.
  expect(host!.querySelector('[data-attachment-stepper]')).toBeNull();
  await act(async () => host!.querySelector<HTMLButtonElement>('[data-full-view-comments]')!.click());
  const pos = host!.querySelector<HTMLButtonElement>('[data-full-view-foot] [data-full-view-position]')!;
  await act(async () => pos.click());
  const sheet = document.querySelector<HTMLElement>('[data-image-peek-sheet]')!;
  expect(sheet).not.toBeNull();
  expect(sheet.querySelector('[data-image-peek="sheet"]')).not.toBeNull();
  expect(sheet.querySelector('[role="row"] [class*="grid-cols-3"]')).not.toBeNull();
  await act(async () => sheet.querySelector<HTMLElement>('[data-peek-backdrop]')!.click());
  await settle();
  expect(document.querySelector('[data-image-peek-sheet]')).toBeNull();
  // The backdrop covered everything: focus goes back to the position that opened it.
  expect(document.activeElement).toBe(pos);
});

test('images in a message come before its attached files, in text order; each says where it was', () => {
  const inline1 = file('att_01K7IIIIIIIIIIIIIIIIIIIIII', 'b.png', 'image', M1, { ref: 'design/b.png' });
  const inline2 = file('att_01K7JJJJJJJJJJJJJJJJJJJJJJ', 'a.png', 'image', M2, { ref: 'design/a.png', captured: 'on_open', changed_since_sent: true });
  const steps = attachmentSequence([message(M1, '2026-10-10T10:42:00.000Z'), message(M2, '2026-10-10T11:06:00.000Z')], [shotB, shotA, zip, spec], [inline2, inline1]);
  expect(steps.map((s) => [s.attachment.name, s.inline])).toEqual([
    ['b.png', true],
    ['desktop.png', false],
    ['refund-policy.pdf', false],
    ['a.png', true],
    ['checkout-mobile.png', false],
    ['fixtures.zip', false],
  ]);
  expect(stepAnnouncement(steps, 0)).toMatch(/^1 of 6, b\.png, PNG image, in Claude's .*message$/);
  expect(stepAnnouncement(steps, 3)).toMatch(/^4 of 6, a\.png, PNG image, changed since you first opened it, in Claude's /);
  // An image in the person's own reply is theirs, never an agent's.
  const M3 = 'msg_01K7M3MMMMMMMMMMMMMMMMMMMM';
  const mine = file('att_01K7KKKKKKKKKKKKKKKKKKKKKK', 'mine.png', 'image', M3, { ref: 'design/mine.png' });
  const reply = { id: M3, created_at: '2026-10-10T11:10:00.000Z', author: { kind: 'person' } } as unknown as InboxMessageWire;
  const withReply = attachmentSequence([message(M1, '2026-10-10T10:42:00.000Z'), reply], [], [mine]);
  expect(withReply[0]!.sender).toBe('You');
  expect(stepAnnouncement(withReply, 0)).toMatch(/^1 of 1, mine\.png, PNG image, in your .*message$/);
});

test.skipIf(!hasDom)('a typed image comment asks first: keep writing, discard, or save it and go on', async () => {
  const saved: object[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    saved.push(body);
    return new Response(
      JSON.stringify({ annotation: { id: body.annotation.id, attachment_id: body.attachment_id, path: shotA.path, version: 'current', annotation: body.annotation, message_id: M1 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  const harness = harnessOf();
  await render(<Pane start={shotA} harness={harness} />);
  const box = () => host!.querySelector<HTMLTextAreaElement>('[data-image-composer] textarea')!;
  const type = async (words: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(box(), words);
      box().dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  await type('The Pay button sits under the fold.');
  await act(async () => host!.querySelector<HTMLButtonElement>('[data-step-next]')!.click());
  const guard = () => host!.querySelector<HTMLElement>('[data-step-guard]');
  expect(guard()).not.toBeNull();
  expect(guard()!.textContent).toContain('Your comment on desktop.png is not saved yet.');
  expect(guard()!.querySelector('[data-guard-discard]')!.textContent).toBe('Discard and go to refund-policy.pdf');
  expect(document.activeElement).toBe(guard()!.querySelector('[data-guard-save]'));
  expect(harness.steps).toEqual([]);
  // The row owns the keys while it is open.
  await key(pane(), { key: ']' });
  expect(harness.steps).toEqual([]);
  // Esc is Keep writing: the text is focused, the cursor at its end.
  await key(guard()!.querySelector('[data-guard-save]')!, { key: 'Escape' });
  expect(guard()).toBeNull();
  expect(document.activeElement).toBe(box());
  expect(box().selectionStart).toBe(box().value.length);

  // Discard: the file changes and the next image's box starts empty.
  await act(async () => host!.querySelector<HTMLButtonElement>('[data-step-next]')!.click());
  await act(async () => guard()!.querySelector<HTMLButtonElement>('[data-guard-discard]')!.click());
  expect(openId()).toBe(spec.id);
  expect(saved).toEqual([]);
  await key(pane(), { key: ']' });
  expect(openId()).toBe(shotB.id);
  expect(box().value).toBe('');

  // Save it and go on: the comment is saved on the file it was typed on, then the step.
  await type('Move it above the fold.');
  await key(pane(), { key: ']' });
  expect(guard()).not.toBeNull();
  await act(async () => guard()!.querySelector<HTMLButtonElement>('[data-guard-save]')!.click());
  await settle();
  expect(openId()).toBe(zip.id);
  expect(saved).toHaveLength(1);
  expect((saved[0] as { attachment_id: string }).attachment_id).toBe(shotB.id);
  expect((saved[0] as { annotation: { text: string } }).annotation.text).toBe('Move it above the fold.');

  // Close asks too.
  await key(pane(), { key: '[' });
  expect(openId()).toBe(shotB.id);
  await type('One more thought.');
  await act(async () => host!.querySelector<HTMLButtonElement>('[aria-label="Close checkout-mobile.png"]')!.click());
  expect(harness.closed).toBe(0);
  expect(guard()!.querySelector('[data-guard-discard]')!.textContent).toBe('Discard and close the file');
  await act(async () => guard()!.querySelector<HTMLButtonElement>('[data-guard-discard]')!.click());
  expect(harness.closed).toBe(1);
});

test.skipIf(!hasDom)('the header drops the file name when the thread has more than one file; one file keeps it and has no stepper', async () => {
  await render(<Pane start={shotA} harness={harnessOf()} />);
  expect(host!.querySelector('[data-header-name]')).toBeNull();
  expect(host!.querySelector('[data-step-name]')!.textContent).toBe('desktop.png');
  act(() => root!.unmount());
  host!.remove();

  const only = attachmentSequence([message(M1, '2026-10-10T10:42:00.000Z')], [shotA]);
  await render(<Pane start={shotA} harness={harnessOf()} steps={only} full={false} />);
  expect(host!.querySelector('[data-header-name]')!.textContent).toBe('desktop.png');
  expect(host!.querySelector('[data-attachment-stepper]')).toBeNull();
  // Beside the thread with one file there is no bar at all.
  expect(host!.querySelector('[data-view-foot]')).toBeNull();
  expect(pane().getAttribute('aria-label')).toBe('desktop.png');
});

test.skipIf(!hasDom)('the arrows stand down inside a block that scrolls sideways, through a shadow root too', async () => {
  const harness = harnessOf();
  await render(<Pane start={spec} harness={harness} />);
  const wide = (el: HTMLElement) => {
    el.style.overflowX = 'auto';
    Object.defineProperty(el, 'scrollWidth', { configurable: true, get: () => 2000 });
    Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => 600 });
  };
  const block = document.createElement('pre');
  wide(block);
  const line = document.createElement('code');
  line.tabIndex = 0;
  block.appendChild(line);
  pane().appendChild(block);
  await key(line, { key: 'ArrowRight' });
  // Pierre's code scroller lives in a shadow root.
  const shadowHost = document.createElement('div');
  pane().appendChild(shadowHost);
  const shadow = shadowHost.attachShadow({ mode: 'open' });
  const scroller = document.createElement('div');
  wide(scroller);
  const inner = document.createElement('span');
  inner.tabIndex = 0;
  scroller.appendChild(inner);
  shadow.appendChild(scroller);
  await key(inner, { key: 'ArrowRight' });
  expect(harness.steps).toEqual([]);
  // ] is not an arrow: it still steps from there.
  await key(line, { key: ']' });
  expect(harness.steps.map((s) => s.id)).toEqual([shotB.id]);
});

