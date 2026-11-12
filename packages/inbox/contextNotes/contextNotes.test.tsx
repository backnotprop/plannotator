import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxNoteBlock } from '@plannotator/core/inbox-context-notes';
import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import type { ContextNote } from './model';

const hasDom = typeof document !== 'undefined';
const { ContextNotesProvider, useContextNotes } = (hasDom ? await import('./ContextNotes') : {}) as typeof import('./ContextNotes');
const { MessageBody } = (hasDom ? await import('../components/Thread') : { MessageBody: null }) as typeof import('../components/Thread');

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(notes: ContextNote[], actions: Parameters<typeof useContextNotes>[1]) {
  function Host() {
    const rows = useContextNotes(notes, actions);
    return <ContextNotesProvider api={rows.api}>{rows.anchors.map((a) => <div key={a.id}>{rows.renderContextNote(a.id)}</div>)}</ContextNotesProvider>;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Host />));
  return host;
}

const answer: ContextNote = { id: 't1', writer: 'thread', file: 'src/a.ts', side: 'new', lineStart: 4, lineEnd: 6, text: 'The retry lives here.', agent: 'Claude Code', asked: 'Why retry?' };

test.skipIf(!hasDom)('a row is a button that opens its note in place, and nothing to reply, edit or post', () => {
  const el = mount([answer], {});
  const button = el.querySelector<HTMLButtonElement>('[data-context-note-row="t1"] button.ib-ctxn-row')!;
  expect(button.getAttribute('aria-expanded')).toBe('false');
  const body = el.querySelector(`#${CSS.escape(button.getAttribute('aria-controls')!)}`) as HTMLElement;
  expect(body.hidden).toBe(true);
  expect(button.querySelector('.ib-ctxn-peb, .ib-ctxn-risk-mark')).toBeNull();
  act(() => button.click());
  expect(button.getAttribute('aria-expanded')).toBe('true');
  expect(body.hidden).toBe(false);
  expect(body.textContent).toContain('you asked “Why retry?”');
  expect(body.textContent).toContain('The retry lives here.');
  const words = Array.from(el.querySelectorAll('button')).map((b) => b.textContent ?? '');
  expect(words.some((w) => /reply|edit|post|delete/i.test(w))).toBe(false);
  act(() => button.click());
  expect(button.getAttribute('aria-expanded')).toBe('false');
});

test.skipIf(!hasDom)('the thread agent’s note is labelled with its name, as the thread names it (the owner, q-38221c8b)', () => {
  const head = (note: ContextNote) => {
    const el = mount([note], {});
    const button = el.querySelector<HTMLButtonElement>('button.ib-ctxn-row')!;
    const label = button.querySelector('.ib-ctxn-h')!.textContent;
    const name = button.textContent ?? '';
    act(() => root?.unmount());
    host?.remove();
    root = null;
    return { label, name };
  };
  const named = head(answer);
  expect(named.label).toBe('Claude Code');
  expect(named.name.startsWith('Claude Code')).toBe(true);
  expect(named.name).not.toContain('Answer');
  expect(head({ ...answer, agent: 'Codex' }).label).toBe('Codex');
  expect(head({ ...answer, agent: undefined }).label).toBe('An agent');
  expect(head({ ...answer, writer: 'guide' }).label).toBe('Review note');
});

test.skipIf(!hasDom)('a stale answer says the code changed, on which round, and asks again with its lines', () => {
  const asked: ContextNote[] = [];
  const el = mount([{ ...answer, stale: { round: 2, lines: [3, 5] } }], { onAskAgain: (note) => asked.push(note) });
  act(() => el.querySelector<HTMLButtonElement>('button.ib-ctxn-row')!.click());
  expect(el.querySelector('[data-context-note-row="t1"]')!.hasAttribute('data-stale')).toBe(true);
  expect(el.querySelector('[data-context-note-stale]')!.textContent).toContain('The code here changed after this answer (written on round 2, lines 3–5).');
  act(() => el.querySelector<HTMLButtonElement>('[data-context-note-ask-again]')!.click());
  expect(asked.map((n) => n.id)).toEqual(['t1']);
});

test.skipIf(!hasDom)('without an Ask (a read-only review) a stale answer offers no Ask again', () => {
  const el = mount([{ ...answer, stale: { round: 1, lines: [4, 4] } }], {});
  act(() => el.querySelector<HTMLButtonElement>('button.ib-ctxn-row')!.click());
  expect(el.querySelector('[data-context-note-ask-again]')).toBeNull();
});

test.skipIf(!hasDom)('a risk shows High and the person’s rule; a picture opens its board', () => {
  const opened: string[] = [];
  const risk: ContextNote = { id: 'r-0', writer: 'risk', file: 'src/a.ts', side: 'new', lineStart: 1, lineEnd: 2, text: 'Charges retry.', level: 'high', rule: 'Anything in billing.' };
  const picture: ContextNote = { id: 'p-1', writer: 'picture', file: 'src/a.ts', side: 'new', lineStart: 8, lineEnd: 8, text: 'Retries once.', agent: 'Claude', picture: { board: 'b1', title: 'Flow', part: 'Retry' } };
  const el = mount([risk, picture], { onOpenPicture: (note) => opened.push(note.picture!.board) });
  const [riskRow, pictureRow] = Array.from(el.querySelectorAll<HTMLButtonElement>('button.ib-ctxn-row'));
  expect(riskRow!.textContent).toContain('Risk');
  expect(riskRow!.textContent).toContain('High');
  expect(riskRow!.querySelector('.ib-ctxn-peb')).toBeNull();
  expect(riskRow!.querySelector('.ib-ctxn-risk-mark')).not.toBeNull();
  expect(pictureRow!.querySelector('.ib-ctxn-peb')).not.toBeNull();
  expect(pictureRow!.querySelector('.ib-ctxn-risk-mark')).toBeNull();
  act(() => riskRow!.click());
  expect(el.querySelector('[data-context-note-row="r-0"]')!.textContent).toContain('your rule “Anything in billing.”');
  act(() => pictureRow!.click());
  act(() => el.querySelector<HTMLButtonElement>('[data-context-note-open-picture]')!.click());
  expect(opened).toEqual(['b1']);
});

test.skipIf(!hasDom)('a risk place with no rule of the person’s, and an answer to nothing they said, add no words of their own', () => {
  const risk: ContextNote = { id: 'r-0', writer: 'risk', file: 'src/a.ts', side: 'new', lineStart: 1, lineEnd: 2, text: 'Charges retry.', level: 'high' };
  const unasked: ContextNote = { ...answer, id: 't2', asked: undefined };
  const timed: ContextNote = { ...answer, id: 't3', asked: undefined, at: new Date().toISOString() };
  const el = mount([risk, unasked, timed], {});
  for (const row of el.querySelectorAll<HTMLButtonElement>('button.ib-ctxn-row')) act(() => row.click());
  expect(el.querySelector('[data-context-note-row="r-0"] .ib-ctxn-by')).toBeNull();
  expect(el.querySelector('[data-context-note-row="t2"] .ib-ctxn-by')).toBeNull();
  expect(el.querySelector('[data-context-note-row="r-0"] .ib-ctxn-t')!.textContent).toBe('Charges retry.');
  const by = el.querySelector('[data-context-note-row="t3"] .ib-ctxn-by')!.textContent!;
  expect(by.startsWith('\u00a0· ')).toBe(true);
  expect(by).not.toContain('Claude');
  expect(by).not.toContain('you asked');
});

test.skipIf(!hasDom)('an open note says who and when on the writer’s line, and a wrap never starts a line with “·”', () => {
  const timed: ContextNote = { ...answer, at: new Date().toISOString() };
  const el = mount([timed], {});
  const button = el.querySelector<HTMLButtonElement>('button.ib-ctxn-row')!;
  act(() => button.click());
  const head = button.querySelector('.ib-ctxn-h')!;
  const by = head.querySelector('.ib-ctxn-by')!;
  expect(head.querySelector('b')!.textContent).toBe('Claude Code');
  expect(by.textContent).toContain('you asked “Why retry?”');
  expect(by.textContent!.match(/·/g)!.length).toBe(2);
  expect(/[^\u00a0]·/.test(head.textContent!)).toBe(false);
  expect(by.getAttribute('aria-hidden')).toBe('true');
  const body = el.querySelector(`#${CSS.escape(button.getAttribute('aria-controls')!)}`)!;
  expect(body.querySelector('.sr-only')!.textContent).toContain('you asked “Why retry?”');
  expect(body.querySelector('.ib-ctxn-by')).toBeNull();
  act(() => button.click());
  expect(button.querySelector('.ib-ctxn-by')).toBeNull();
  expect(button.querySelector('.ib-ctxn-first')!.textContent).toBe('The retry lives here.');
});

async function renderMessage(body: string, contextNotes?: { onOpen?: (note: InboxNoteBlock) => void }) {
  const message = {
    id: 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
    thread_id: 'msg_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
    project_id: 'prj_01K7ZZZZZZZZZZZZZZZZZZZZZZ',
    author: { kind: 'agent', host: 'claude-code', session: 'ses_1', name: 'Claude Code' },
    body,
    attachments: [],
    questions: [],
  } as unknown as InboxMessageWire;
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(<MessageBody message={message} projectRoot="/work/widgets" onOpenAttachment={() => {}} readOnly answers={new Map()} onPick={() => {}} footerFor={() => null} {...(contextNotes ? { contextNotes } : {})} />);
  });
  return host;
}

const NOTE_MESSAGE = 'Here is why.\n\n:::note src/jobs/retry.ts#L3-L4 old\nNothing removes the **row**.\n:::\n\nThe rest stays.';

test.skipIf(!hasDom)('a `:::note` block is a chip with its words, never its anchor line, and opens its lines on their side', async () => {
  const opened: InboxNoteBlock[] = [];
  const el = await renderMessage(NOTE_MESSAGE, { onOpen: (note) => opened.push(note) });
  const block = el.querySelector('[data-context-note-block]')!;
  expect(block).not.toBeNull();
  expect(el.textContent).not.toContain('#L3-L4');
  expect(el.textContent).not.toContain(':::');
  expect(el.textContent).toContain('Here is why.');
  expect(el.textContent).toContain('The rest stays.');
  expect(block.querySelector('strong')?.textContent).toBe('row');
  const chip = block.querySelector<HTMLElement>('[data-context-note-chip]')!;
  expect(chip.tagName).toBe('BUTTON');
  expect(chip.getAttribute('title')).toBe('src/jobs/retry.ts');
  expect(chip.textContent).toContain('retry.ts');
  expect(chip.textContent).toContain('removed 3–4');
  act(() => chip.click());
  expect(opened.map((n) => [n.file, n.side, n.lineStart, n.lineEnd])).toEqual([['src/jobs/retry.ts', 'old', 3, 4]]);
});

test.skipIf(!hasDom)('a note with no review to open (written before the thread’s first one) is a chip with no way in', async () => {
  const el = await renderMessage(NOTE_MESSAGE, {});
  const chip = el.querySelector<HTMLElement>('[data-context-note-chip]')!;
  expect(chip.tagName).toBe('SPAN');
  expect(chip.querySelector('.ib-ctxn-chip-go')).toBeNull();
  expect(el.querySelector('[data-context-note-block] strong')?.textContent).toBe('row');
});
