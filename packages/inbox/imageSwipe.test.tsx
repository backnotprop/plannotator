/**
 * A phone's swipe between images (approval "inbox-image-swipe",
 * 2026-10-28): a question's picture choices open as a set of their own
 * (Option sets), captioned with the choice on screen (Option caption); an
 * image follows the finger with the next one beside it, steps past a third
 * of the width or on a flick, springs back short of that and resists at the
 * ends (Follow the finger); a drag down closes the viewer (Swipe down to
 * close). Under reduced motion nothing follows the finger.
 *
 * What is proved here, on the pane as the thread drives it on a phone: the
 * set's order and its ends, the caption and the pill, the sheet still listing
 * every file, the follow thresholds, the neighbour drawn beside the image and
 * over it while the step lands, the drag down, one image alone, and reduced
 * motion. Which way a zoomed image pans first is in imageZoom.test.tsx; the
 * real-touch proof is tests/e2e/inbox-image-swipe.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeAll, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAttachmentState, InboxMessageWire } from '@plannotator/core/inbox-types';
import { attachmentSequence, type AttachmentStep } from './stepping';
import { SWIPE_HANDOFF_MAX_MS, SWIPE_SLIDE_MS } from './fileSwipe';
import { optionSetId, optionSetOf, type OptionSet } from './optionSets';

const hasDom = typeof document !== 'undefined';
const { AttachmentPane } = (hasDom ? await import('./components/AttachmentPane') : {}) as typeof import('./components/AttachmentPane');

let root: Root | null = null;
let host: HTMLElement | null = null;
const realFetch = globalThis.fetch;
const realMatchMedia = hasDom ? window.matchMedia : undefined;

beforeAll(() => {
  if (hasDom) (window as unknown as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL('http://localhost:4000/');
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = realFetch;
  if (hasDom) {
    window.matchMedia = realMatchMedia!;
    for (const stray of document.querySelectorAll('.pn-inbox')) stray.remove();
  }
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
const pic = (letter: string) => file(`att_01K7OPT${letter}${letter.repeat(18)}`, `opt-${letter.toLowerCase()}.png`, 'image', M2, { media_type: 'image/png', ref: `shots/opt-${letter.toLowerCase()}.png` });
const [optA, optB, optC, optD] = ['A', 'B', 'C', 'D'].map(pic) as [InboxAttachmentState, InboxAttachmentState, InboxAttachmentState, InboxAttachmentState];
const page = file('att_01K7DDDDDDDDDDDDDDDDDDDDDD', 'turnkey.html', 'html', M2);
const ALL = [notes, optA, optB, optC, optD, page];

const choice = (label: string, letter: string, recommended = false) => ({ label, description: null, recommended, settled: false, image: { alt: `Option ${letter}`, src: `shots/opt-${letter.toLowerCase()}.png` } });
function message(id: string, createdAt: string, extra: Record<string, unknown> = {}): InboxMessageWire {
  return { id, created_at: createdAt, author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude' }, ...extra } as unknown as InboxMessageWire;
}
const QUESTION = {
  key: 'q-design',
  prompt: 'Which copy-message design should ship?',
  choices: [choice('Gmail-style ⋯', 'A', true), choice('Quiet hover menu', 'B'), choice('Hover copy icon', 'C'), choice('Header menu only', 'D')],
};
const MESSAGES = [message(M1, '2026-10-10T10:42:00.000Z'), message(M2, '2026-10-10T11:06:00.000Z', { questions: [QUESTION] })];
// The thread's files, every one of them; the images are the message's text images (the choices' pictures).
const ALL_STEPS: AttachmentStep[] = attachmentSequence(MESSAGES, ALL).map((s) => (s.attachment.kind === 'image' ? { ...s, inline: true } : s));
const SET: OptionSet = optionSetOf(MESSAGES, ALL_STEPS, optionSetId(M2, 'q-design'))!;

function stubViews() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    const att = ALL.find((a) => url.includes(a.id));
    if (att && url.includes('/view')) {
      const html = att.kind === 'html' ? '<h1>Checkout</h1>' : null;
      return new Response(JSON.stringify({ attachment: att, version: 'current', text: html ?? `# ${att.name}\n`, html }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
}

/** The pane as the thread drives it on a phone; `set`: the thread opened it over the question's choices. */
function Pane({ start, opened, closed, set, only, setOf = SET }: { start: InboxAttachmentState; opened: string[]; closed: () => void; set: boolean; only?: boolean; setOf?: OptionSet }) {
  const [open, setOpen] = useState(start);
  const noop = () => {};
  const inSet = set && setOf.steps.some((s) => s.attachment.id === open.id);
  const steps = only ? ALL_STEPS.filter((s) => s.attachment.id === start.id) : inSet ? setOf.steps : ALL_STEPS;
  return (
    <AttachmentPane
      attachment={open}
      attachments={ALL}
      records={[]}
      agent="Claude Code"
      projectName="shop"
      projectRoot="/work/shop"
      version="current"
      onVersion={noop}
      full
      fullLocked
      onToggleFull={noop}
      focusId={null}
      readOnly={false}
      onSaved={noop}
      onRemoved={noop}
      onOpenAt={noop}
      onClose={closed}
      strip={{ picks: 0, annotations: 0, onWriteReply: noop }}
      steps={steps}
      allSteps={ALL_STEPS}
      optionSet={inSet ? setOf : null}
      phone
      onStep={(id) => {
        opened.push(id);
        setOpen(ALL.find((a) => a.id === id)!);
      }}
    />
  );
}

async function settle(ms = 60) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function render(start: InboxAttachmentState, { set = true, only = false, setOf = SET } = {}) {
  const opened: string[] = [];
  const closes = { count: 0 };
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<Pane start={start} opened={opened} closed={() => closes.count++} set={set} only={only} setOf={setOf} />);
  });
  await settle();
  sized(area());
  return { opened, closes };
}

const area = () => host!.querySelector<HTMLElement>('.ib-docarea')!;
/** The picture on screen (what follows the finger), and the layer the neighbours are drawn in beside it. */
const picture = () => area().querySelector<HTMLElement>('.ib-imgstage > .ib-zoomstage')!;
const beside = () => host!.querySelector<HTMLElement>('.ib-imgpeeks');
/** What stays put while the picture moves: the file area, the image's stage with its size bar, the comment box. */
const stayingPut = () => [area(), area().querySelector<HTMLElement>('.ib-imgstage')!, area().querySelector<HTMLElement>('.ib-imgbar')!, area().querySelector<HTMLElement>('.ib-imgcompose')!].map((el) => el.style.transform);
const pane = () => host!.querySelector<HTMLElement>('[data-attachment-pane]')!;
const pill = () => host!.querySelector<HTMLButtonElement>('[data-full-view-bar] [data-full-view-position]')!;
const caption = () => host!.querySelector<HTMLElement>('[data-option-caption]');
const live = () => host!.querySelector('[data-step-live]')!.textContent;
const peek = (place: string) => host!.querySelector(`.ib-imgpeek[data-image-peek="${place}"]`);

/** The phone's size for the file and the body around it, where the swipe is heard (happy-dom lays nothing out). */
function sized(el: HTMLElement, width = 390, height = 700) {
  for (const node of [el, el.parentElement!]) node.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) }) as DOMRect;
}

function reducedMotion(on: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: on && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function touchEvent(target: EventTarget, type: string, points: { x: number; y: number }[]) {
  const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
  const list = points.map((p, i) => ({ identifier: i, clientX: p.x, clientY: p.y, target }));
  Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : list });
  Object.defineProperty(event, 'changedTouches', { value: list });
  target.dispatchEvent(event);
}

/**
 * One finger from (200, 300) by (dx, dy) in `moves` moves, then lifted (unless `lift` is false). `rest`: the finger
 * stops before it lifts (a last move where it is, a moment later), so the release is no flick.
 */
async function drag(dx: number, dy = 0, { moves = 6, lift = true, rest = false } = {}) {
  const target = area().querySelector('.ib-imgstage') ?? area();
  const from = { x: 200, y: 300 };
  await act(async () => {
    touchEvent(target, 'touchstart', [from]);
    for (let i = 1; i <= moves; i++) touchEvent(target, 'touchmove', [{ x: from.x + (dx * i) / moves, y: from.y + (dy * i) / moves }]);
  });
  if (rest) {
    await settle(40);
    await act(async () => touchEvent(target, 'touchmove', [{ x: from.x + dx, y: from.y + dy }]));
  }
  if (lift) await release(target, from.x + dx, from.y + dy);
}

async function release(target: EventTarget = area().querySelector('.ib-imgstage') ?? area(), x = 0, y = 0) {
  await act(async () => {
    touchEvent(target, 'touchend', [{ x, y }]);
  });
}

test.skipIf(!hasDom)('a picture choice opens its question\'s choices: the caption names each, the pill counts them, the swipe stops at the first and last', async () => {
  stubViews();
  reducedMotion(true);
  const { opened } = await render(optB);
  expect(caption()!.getAttribute('data-option-caption')).toBe('B');
  expect(caption()!.querySelector('.ib-optcap-label')!.textContent).toBe('Option B: Quiet hover menu');
  expect(caption()!.querySelector('.ib-optcap-prompt')!.textContent).toBe('Which copy-message design should ship?');
  expect(caption()!.querySelector('[data-option-dots]')!.getAttribute('data-option-dots')).toBe('2/4');
  expect(caption()!.querySelectorAll('.ib-optcap-dots i')).toHaveLength(4);
  expect(caption()!.querySelector('[data-option-recommended]')).toBeNull();
  expect(caption()!.querySelector('[data-option-end]')).toBeNull();
  expect(pill().textContent).toContain('2/4');
  expect(pill().getAttribute('aria-label')).toBe('2/4: option 2 of 4, opt-b.png. Show every file');
  expect(pane().getAttribute('aria-label')).toBe('opt-b.png, option 2 of 4');
  // The thread's step chip gives way to the caption.
  expect(host!.querySelector('[data-full-view-chip]')).toBeNull();

  // Finger left: the next choice, in choice order (C, then D), never the thread's other files.
  await drag(-200);
  await settle(40);
  expect(opened).toEqual([optC.id]);
  expect(caption()!.getAttribute('data-option-caption')).toBe('C');
  expect(live()).toBe('Option C of 4: Hover copy icon');
  await drag(-200);
  await settle(40);
  expect(opened).toEqual([optC.id, optD.id]);
  // The last choice: the caption says where the thread's other files are.
  expect(caption()!.querySelector('[data-option-end]')!.textContent).toBe("Last option · the thread's 2 other files are under 4/4");
  await drag(-200);
  await settle(40);
  expect(opened).toEqual([optC.id, optD.id]);
  expect(live()).toBe('Last option');

  // Finger right, back to A (recommended), and no further.
  for (let i = 0; i < 3; i++) {
    await drag(200);
    await settle(40);
  }
  expect(opened.slice(2)).toEqual([optC.id, optB.id, optA.id]);
  expect(caption()!.querySelector('[data-option-recommended]')!.textContent).toBe('Recommended');
  await drag(200);
  await settle(40);
  expect(opened).toHaveLength(5);
  expect(caption()!.querySelector('[data-option-end]')!.textContent).toBe('First option');
});

test.skipIf(!hasDom)('choices labeled with their own letters out of order (C, A, B) are captioned by that letter, with no chip of a position letter', async () => {
  stubViews();
  reducedMotion(true);
  const cab = message(M2, '2026-10-10T11:06:00.000Z', {
    questions: [{ key: 'q-design', prompt: 'Which?', choices: [choice('C · The section is the folder', 'C'), choice('A · A tab', 'A'), choice('B · Header menu', 'B')] }],
  });
  const steps = attachmentSequence([MESSAGES[0]!, cab], ALL).map((s) => (s.attachment.kind === 'image' ? { ...s, inline: true } : s));
  const cabSet = optionSetOf([MESSAGES[0]!, cab], steps, optionSetId(M2, 'q-design'))!;
  await render(optC, { setOf: cabSet });
  expect(caption()!.getAttribute('data-option-caption')).toBe('C');
  expect(caption()!.querySelector('.ib-optcap-letter')).toBeNull();
  expect(caption()!.querySelector('.ib-optcap-label')!.textContent).toBe('C · The section is the folder');
});

test.skipIf(!hasDom)('the pill\'s sheet still lists every file of the thread; its ‹ Previous and Next › step inside the set; a pick outside leaves it', async () => {
  stubViews();
  reducedMotion(true);
  const { opened } = await render(optB);
  await act(async () => pill().click());
  await settle();
  const sheet = document.querySelector<HTMLElement>('[data-image-peek-sheet]')!;
  expect([...sheet.querySelectorAll('[data-peek-item]')].map((el) => el.getAttribute('data-peek-item'))).toEqual(ALL_STEPS.map((s) => s.attachment.id));
  expect(sheet.querySelector('[data-peek-step-prev]')!.getAttribute('aria-label')).toBe('Previous option: opt-a.png');
  expect(sheet.querySelector('[data-peek-step-next]')!.getAttribute('aria-label')).toBe('Next option: opt-c.png');
  await act(async () => sheet.querySelector<HTMLElement>(`[data-peek-item="${notes.id}"]`)!.click());
  await settle();
  expect(opened).toEqual([notes.id]);
  // Out of the set: the thread's own count and its chip, no caption.
  expect(caption()).toBeNull();
  expect(pill().textContent).toContain(`1/${ALL_STEPS.length}`);
});

test.skipIf(!hasDom)('the image follows the finger with the next image beside it; short of a third it springs back, past it (or on a flick) it steps, and the next image covers the step', async () => {
  stubViews();
  reducedMotion(false);
  const { opened } = await render(optB);
  // Both neighbours are drawn beside the image, ready before a swipe needs them; no "Next · name" card for an image.
  expect(peek('previous')).not.toBeNull();
  expect(peek('next')).not.toBeNull();
  await drag(-100, 0, { lift: false, rest: true });
  // Only the picture and the neighbours beside it move (approval mock 2): the size bar and the comment box stay put.
  expect(picture().style.transform).toBe('translateX(-100px)');
  expect(beside()!.style.transform).toBe('translateX(-100px)');
  expect(stayingPut()).toEqual(['', '', '', '']);
  expect(host!.querySelector('[data-file-swipe-card]')).toBeNull();
  await release();
  await settle(SWIPE_SLIDE_MS + 120);
  expect(opened).toEqual([]);
  expect(picture().style.transform).toBe('');
  expect(beside()!.style.transform).toBe('');

  // Past a third of the width: the image and its neighbour slide a full width and the gap, then the step.
  await drag(-200);
  expect(picture().style.transform).toBe('translateX(-406px)');
  expect(beside()!.style.transform).toBe('translateX(-406px)');
  expect(stayingPut()).toEqual(['', '', '', '']);
  await settle(SWIPE_SLIDE_MS + 40);
  expect(opened).toEqual([optC.id]);
  expect(picture().style.transform).toBe('');
  expect(beside()!.style.transform).toBe('');
  // The image stepped to stays drawn over the area until the new image is on screen (here it never loads: its timer).
  expect(peek('cover')).not.toBeNull();
  await settle(SWIPE_HANDOFF_MAX_MS + 60);
  expect(peek('cover')).toBeNull();

  // A flick: short, but fast.
  await drag(-60, 0, { moves: 2 });
  await settle(SWIPE_SLIDE_MS + 60);
  expect(opened).toEqual([optC.id, optD.id]);

  // At the last choice it resists (a third of the finger's travel) and does not step.
  await drag(-150, 0, { lift: false });
  expect(picture().style.transform).toBe('translateX(-50px)');
  expect(stayingPut()).toEqual(['', '', '', '']);
  await release();
  await settle(80);
  expect(opened).toEqual([optC.id, optD.id]);
});

test.skipIf(!hasDom)('a finger that comes back while the step is still sliding lands it at once and starts the next swipe: two quick flicks from B reach D', async () => {
  stubViews();
  reducedMotion(false);
  const { opened } = await render(optB);
  const flick = async () => {
    // As a browser runs it: the touchstart lands (and draws) before the finger's moves come.
    const target = area().querySelector('.ib-imgstage')!;
    await act(async () => touchEvent(target, 'touchstart', [{ x: 200, y: 300 }]));
    await act(async () => {
      touchEvent(target, 'touchmove', [{ x: 170, y: 300 }]);
      touchEvent(target, 'touchmove', [{ x: 140, y: 300 }]);
    });
    await release(target, 140, 300);
  };
  await flick();
  // Still sliding toward C (nothing stepped yet) when the second flick begins.
  expect(picture().style.transform).toBe('translateX(-406px)');
  expect(opened).toEqual([]);
  await flick();
  // The first step landed as the finger came down; the second slides on from C.
  expect(opened).toEqual([optC.id]);
  await settle(SWIPE_SLIDE_MS + 60);
  expect(opened).toEqual([optC.id, optD.id]);
  expect(caption()!.getAttribute('data-option-caption')).toBe('D');
});

test.skipIf(!hasDom)('a drag down closes the viewer the way Back does; short of the line it springs back', async () => {
  stubViews();
  reducedMotion(false);
  const { closes } = await render(optB);
  // Short of the line, and the finger stops before it lifts (no flick).
  await drag(2, 80, { lift: false, rest: true });
  // The picture follows the finger down; its size bar and comment box stay where they are and fade.
  expect(picture().style.transform).toBe('translateY(80px)');
  expect(stayingPut()).toEqual(['', '', '', '']);
  expect(pane().hasAttribute('data-dismissing')).toBe(true);
  expect(Number(area().querySelector<HTMLElement>('.ib-imgbar')!.style.opacity)).toBeLessThan(1);
  await release();
  await settle(SWIPE_SLIDE_MS + 120);
  expect(closes.count).toBe(0);
  expect(picture().style.transform).toBe('');
  expect(pane().hasAttribute('data-dismissing')).toBe(false);
  expect(area().querySelector<HTMLElement>('.ib-imgbar')!.style.opacity).toBe('');

  await drag(4, 200);
  await settle(SWIPE_SLIDE_MS + 40);
  expect(closes.count).toBe(1);
});

test.skipIf(!hasDom)('one image alone: a sideways drag is its own (nothing moves), a drag down still closes', async () => {
  stubViews();
  reducedMotion(false);
  const { opened, closes } = await render(optB, { set: false, only: true });
  await drag(-200, 0, { lift: false });
  expect(picture().style.transform).toBe('');
  expect(area().style.transform).toBe('');
  await release();
  await settle(SWIPE_SLIDE_MS + 40);
  expect(opened).toEqual([]);
  await drag(0, 220);
  await settle(SWIPE_SLIDE_MS + 40);
  expect(closes.count).toBe(1);
});

test.skipIf(!hasDom)('under reduced motion nothing follows the finger: the step and the close happen on release', async () => {
  stubViews();
  reducedMotion(true);
  const { opened, closes } = await render(optB);
  // No neighbour drawn beside the image (nothing slides in).
  expect(peek('next')).toBeNull();
  await drag(-200, 0, { lift: false });
  expect(picture().style.transform).toBe('');
  expect(area().style.transform).toBe('');
  await release();
  await settle(20);
  expect(opened).toEqual([optC.id]);
  await drag(0, 200, { lift: false });
  expect(picture().style.transform).toBe('');
  expect(pane().hasAttribute('data-dismissing')).toBe(false);
  await release();
  await settle(20);
  expect(closes.count).toBe(1);
});
