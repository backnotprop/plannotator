import { afterEach, describe, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAnnotationRecord, InboxAttachmentState, InboxMessageWire } from '@plannotator/core/inbox-types';
import { attachmentSequence, type AttachmentStep } from './stepping';
import { earlierCommentsOn } from './earlierComments';
import { videoCommentAnnotation } from './attachments';
import { EarlierCommentsList } from './components/EarlierCommentsList';

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
});

const M1 = 'msg_01K7M1MMMMMMMMMMMMMMMMMMMM';

function file(id: string, name: string): InboxAttachmentState {
  return {
    id,
    name,
    path: `/work/shop/${name}`,
    kind: 'markdown',
    named_path: null,
    sent_sha256: 'a'.repeat(64),
    size: 1000,
    sent_at: '2026-10-10T10:42:00.000Z',
    sent_mtime: '2026-10-10T10:42:00.000Z',
    message_id: M1,
    changed_since_sent: false,
    unavailable: null,
    current: { sha256: 'a'.repeat(64), size: 1000, mtime: '2026-10-10T10:42:00.000Z' },
  } as InboxAttachmentState;
}

const notes = file('att_01K7AAAAAAAAAAAAAAAAAAAAAA', 'notes.md');
const other = file('att_01K7BBBBBBBBBBBBBBBBBBBBBB', 'other.md');
const STEPS: AttachmentStep[] = attachmentSequence([{ id: M1, created_at: '2026-10-10T10:42:00.000Z', author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude' } } as unknown as InboxMessageWire], [notes, other]);

const annotation = (id: string, text: string, originalText: string) => ({ id, blockId: 'block-0', startOffset: 0, endOffset: 4, type: 'COMMENT', text, originalText, createdA: 1 });

const EARLIER = {
  id: 'ann_old',
  attachment_id: 'att_01K7OLDOLDOLDOLDOLDOLDOLDO',
  path: notes.path,
  version: 'current',
  sent_reply_id: 'msg_reply',
  updated_at: '2026-10-09T10:00:00.000Z',
  annotation: annotation('ann_old', 'Say why.', 'Plan'),
} as unknown as InboxAnnotationRecord;

const draft = (id: string, on = notes) =>
  ({ id, attachment_id: on.id, path: on.path, version: 'current', sent_reply_id: null, annotation: annotation(id, 'New words.', 'Ship') }) as unknown as InboxAnnotationRecord;

interface Harness {
  setRecords?: (records: InboxAnnotationRecord[]) => void;
  step?: (id: string) => void;
}

function Pane({ harness = {}, records: start = [], earlier = [EARLIER], full: startFull = true, phone = false, only }: { harness?: Harness; records?: InboxAnnotationRecord[]; earlier?: InboxAnnotationRecord[]; full?: boolean; phone?: boolean; only?: InboxAttachmentState }) {
  const [open, setOpen] = useState(only ?? notes);
  const [records, setRecords] = useState(start);
  const noop = () => {};
  harness.setRecords = setRecords;
  harness.step = (id) => setOpen([notes, other].find((a) => a.id === id)!);
  return (
    <AttachmentPane
      attachment={open}
      attachments={only ? [only] : [notes, other]}
      records={records}
      earlierRecords={earlier}
      agent="Claude Code"
      projectName="shop"
      projectRoot="/work/shop"
      version="current"
      onVersion={noop}
      full={startFull || phone}
      fullLocked={phone}
      onToggleFull={noop}
      focusId={null}
      readOnly={false}
      onSaved={noop}
      onRemoved={noop}
      onOpenAt={noop}
      onClose={noop}
      strip={{ picks: 0, annotations: records.length, onWriteReply: noop }}
      steps={STEPS}
      phone={phone}
      onStep={(id) => setOpen([notes, other].find((a) => a.id === id)!)}
    />
  );
}

async function settle(ms = 60) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function render(node: React.ReactNode) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const att = [notes, other].find((a) => String(input).includes(a.id));
    if (att && String(input).includes('/view')) return new Response(JSON.stringify({ attachment: att, version: 'current', text: '# Plan\n\nShip it.\n', html: null }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(node);
  });
  await settle();
}

const button = () => host!.querySelector<HTMLButtonElement>('[data-full-view-comments]')!;
const section = () => host!.querySelector<HTMLElement>('[data-earlier-section]');
const row = () => host!.querySelector<HTMLButtonElement>('[data-earlier-row]')!;
const listed = () => host!.querySelector('[data-earlier-comment="ann_old"]');
const column = () => host!.querySelector<HTMLElement>('.ib-apanel')!;
const muted = (el: Element) => [...el.querySelectorAll('.ib-earlier-cnt')].map((s) => s.textContent);
const reads = () => button().textContent;
const click = async (el: HTMLElement) => {
  await act(async () => el.click());
  await settle();
};
const openColumn = async () => {
  const comments = host!.querySelector<HTMLButtonElement>('[data-full-view-comments]');
  if (comments?.getAttribute('aria-expanded') === 'false') await click(comments);
};

describe('the comments button', () => {
  test.skipIf(!hasDom)('desktop: "2 · 3" with the 3 muted; a muted "3" with no current comments; today\'s number with no earlier comments', async () => {
    await render(<Pane records={[draft('d1'), draft('d2')]} earlier={[EARLIER, { ...EARLIER, id: 'b' }, { ...EARLIER, id: 'c' }]} />);
    expect(reads()).toBe('2· 3');
    expect(muted(button())).toEqual(['· 3']);
    expect(button().getAttribute('aria-label')).toBe('Comments, 2, 3 earlier');
    act(() => root?.unmount());
    host?.remove();

    await render(<Pane earlier={[EARLIER, { ...EARLIER, id: 'b' }, { ...EARLIER, id: 'c' }]} />);
    expect(reads()).toBe('3');
    expect(muted(button())).toEqual(['3']);
    act(() => root?.unmount());
    host?.remove();

    await render(<Pane earlier={[]} />);
    expect(reads()).toBe('0');
    expect(muted(button())).toEqual([]);
    expect(button().getAttribute('aria-label')).toBe('Comments, 0');
  });

  test.skipIf(!hasDom)('phone: a muted "3" with no current comments, otherwise today\'s number alone', async () => {
    const three = [EARLIER, { ...EARLIER, id: 'b' }, { ...EARLIER, id: 'c' }];
    await render(<Pane phone earlier={three} />);
    expect(reads()).toBe('3');
    expect(muted(button())).toEqual(['3']);
    act(() => root?.unmount());
    host?.remove();

    await render(<Pane phone records={[draft('d1'), draft('d2')]} earlier={three} />);
    expect(reads()).toBe('2');
    expect(muted(button())).toEqual([]);
  });
});

for (const [mode, props] of [
  ['full screen', { full: true }],
  ['side by side', { full: false }],
  ['phone', { phone: true }],
] as const) {
  describe(`the fold rule, ${mode}`, () => {
    test.skipIf(!hasDom)('open with no comments of your own; your first comment keeps it open', async () => {
      const harness: Harness = {};
      await render(<Pane {...props} harness={harness} />);
      await openColumn();
      expect(row().getAttribute('aria-expanded')).toBe('true');
      expect(listed()?.textContent).toBe('"Plan"Say why.');
      await act(async () => harness.setRecords!([draft('d1')]));
      await settle();
      expect(row().getAttribute('aria-expanded')).toBe('true');
      expect(listed() === null).toBe(false);
    });

    test.skipIf(!hasDom)('folded to its row with comments of your own, and a click opens it; removing your last comment opens it', async () => {
      const harness: Harness = {};
      await render(<Pane {...props} harness={harness} records={[draft('d1')]} />);
      await openColumn();
      expect(row().getAttribute('aria-expanded')).toBe('false');
      expect(listed() === null).toBe(true);
      await click(row());
      expect(listed() === null).toBe(false);
      await click(row());
      expect(listed() === null).toBe(true);
      await act(async () => harness.setRecords!([]));
      await settle();
      expect(listed() === null).toBe(false);
    });

    test.skipIf(!hasDom)('it sits in the comments column, after the current comments, read only', async () => {
      await render(<Pane {...props} records={[draft('d1')]} />);
      await openColumn();
      await click(row());
      expect(column().contains(section())).toBe(true);
      const card = column().querySelector('[data-annotation-id="d1"]')!;
      expect(Boolean(card.compareDocumentPosition(section()!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
      const controls = [...section()!.querySelectorAll('button, textarea, a')];
      expect(controls.length).toBe(1);
      expect(controls[0] === row()).toBe(true);
    });
  });
}

describe('nothing reads as gone', () => {
  test.skipIf(!hasDom)('earlier comments and nothing else: no "0", no "No annotations yet", no "0 annotations ride", and Write the reply stays', async () => {
    await render(<Pane />);
    const text = column().textContent!;
    expect(column().querySelector('.ib-sheet-h')!.textContent).toBe('Comments');
    expect(text).not.toContain('No annotations yet');
    expect(column().querySelector('[data-strip-chip]') === null).toBe(true);
    expect(text).toContain('Write the reply');
    expect(row().textContent).toBe('Earlier1');
  });

  test.skipIf(!hasDom)('side by side the column is called Comments, with no empty message', async () => {
    await render(<Pane full={false} />);
    expect(column().querySelector('h2')!.textContent).toBe('Comments');
    expect(column().textContent).not.toContain('Annotations');
    expect(column().textContent).not.toContain('No annotations yet');
  });

  test.skipIf(!hasDom)('a draft on another file: the column says so, and the row reads "Earlier on this file" under All files', async () => {
    await render(<Pane records={[draft('d1', other)]} />);
    expect(column().querySelector('[data-strip-chip]')!.textContent).toContain('1 annotation');
    expect(column().querySelector('[data-strip-chip]')!.textContent).toContain('on other files');
    expect(row().textContent).toBe('Earlier on this file1');
    expect(column().querySelector('.ib-sheet-h')!.textContent).toBe('Comments');
    expect(reads()).toBe('1');
    expect(button().getAttribute('aria-label')).toBe('Comments, 1 earlier');
  });
});

test.skipIf(!hasDom)('a file with no earlier comments is exactly today\'s: no section, and the empty message and the foot stay', async () => {
  await render(<Pane earlier={[{ ...EARLIER, path: other.path }]} />);
  expect(section() === null).toBe(true);
  expect(column().querySelector('.ib-sheet-h')!.textContent).toContain('0');
  expect(column().textContent).toContain('No annotations yet');
  expect(column().querySelector('[data-strip-chip]')!.textContent).toContain('0 annotations');
});

test.skipIf(!hasDom)('the drawer is not forced: earlier comments leave it as it was remembered, closed', async () => {
  await render(<Pane />);
  expect(column().getAttribute('data-comments-drawer')).toBe('closed');
  expect(button().getAttribute('aria-expanded')).toBe('false');
});

test.skipIf(!hasDom)('stepping to a file with its own comments starts by the fold rule again', async () => {
  const harness: Harness = {};
  await render(<Pane harness={harness} earlier={[EARLIER, { ...EARLIER, id: 'on-other', path: other.path }]} records={[draft('d2', other)]} />);
  expect(row().getAttribute('aria-expanded')).toBe('true');
  await act(async () => harness.step!(other.id));
  await settle();
  expect(row().getAttribute('aria-expanded')).toBe('false');
});

test.skipIf(!hasDom)('the list stands alone, with no host around it', async () => {
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<EarlierCommentsList replies={earlierCommentsOn([EARLIER], notes)} />);
  });
  expect(host.querySelector('[data-earlier-comment="ann_old"]')!.textContent).toBe('"Plan"Say why.');
  expect(host.textContent).toContain('From your reply');
  expect(host.querySelector('button') === null).toBe(true);
});

test.skipIf(!hasDom)('a closed drawer draws the row and not the list, however long it is, and opening draws it', async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ ...EARLIER, id: `old-${i}` }));
  await render(<Pane earlier={many} />);
  expect(row().getAttribute('aria-expanded')).toBe('true');
  expect(host!.querySelectorAll('[data-earlier-comment]').length).toBe(0);
  await openColumn();
  expect(host!.querySelectorAll('[data-earlier-comment]').length).toBe(40);
});

test.skipIf(!hasDom)('a download takes no comments: a column only when it has earlier ones to list', async () => {
  const pdf = { ...file('att_01K7CCCCCCCCCCCCCCCCCCCCCC', 'terms.pdf'), kind: 'file' } as InboxAttachmentState;
  await render(<Pane only={pdf} earlier={[{ ...EARLIER, path: pdf.path }]} full={false} />);
  expect(host!.querySelector('.ib-view')!.classList.contains('ib-nopanel')).toBe(false);
  expect(section() === null).toBe(false);
  act(() => root?.unmount());
  host?.remove();

  await render(<Pane only={pdf} earlier={[]} full={false} />);
  expect(host!.querySelector('.ib-view')!.classList.contains('ib-nopanel')).toBe(true);
  expect(section() === null).toBe(true);
});

test.skipIf(!hasDom)('the list opening on its own moves nothing; only a press on the row brings its first comment in', async () => {
  const real = Element.prototype.scrollIntoView;
  const scrolled: string[] = [];
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.getAttribute('data-earlier-comment') ?? '');
  };
  try {
    await render(<Pane full={false} />);
    expect(scrolled.filter(Boolean)).toEqual([]);
    await click(row());
    await click(row());
    expect(scrolled.filter(Boolean)).toEqual(['ann_old']);
  } finally {
    Element.prototype.scrollIntoView = real;
  }
});

test.skipIf(!hasDom)('a film\'s earlier comments read by time inside a reply, whatever order they were made in', () => {
  const film = { ...notes, kind: 'video' } as InboxAttachmentState;
  const at = (id: string, time: number) => ({ ...EARLIER, id, annotation: videoCommentAnnotation({ id, name: 'cut.mp4', time, text: `At ${time}` }) }) as unknown as InboxAnnotationRecord;
  const [reply] = earlierCommentsOn([at('late', 90), at('early', 10), at('middle', 40)], film);
  expect(reply!.comments.map((c) => c.id)).toEqual(['early', 'middle', 'late']);
  expect(reply!.comments[0]!.spot).toBe('At 0:10');
});
