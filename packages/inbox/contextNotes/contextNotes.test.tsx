/**
 * A context note's row (approval "inbox-context-notes", take Line). What
 * regresses: a row that is not a button a keyboard reaches (no aria-expanded,
 * nothing it controls), a note that grows a reply, edit or Post, a stale answer
 * without its words or its Ask again, a picture's note that can't open its board.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ContextNote } from './model';

const hasDom = typeof document !== 'undefined';
const { ContextNotesProvider, useContextNotes } = (hasDom ? await import('./ContextNotes') : {}) as typeof import('./ContextNotes');

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

const answer: ContextNote = { id: 't1', writer: 'thread', file: 'src/a.ts', side: 'new', lineStart: 4, lineEnd: 6, text: 'The retry lives here.', agent: 'Claude', asked: 'Why retry?' };

test.skipIf(!hasDom)('a row is a button that opens its note in place, and nothing to reply, edit or post', () => {
  const el = mount([answer], {});
  const button = el.querySelector<HTMLButtonElement>('[data-context-note-row="t1"] button.ib-ctxn-row')!;
  expect(button.getAttribute('aria-expanded')).toBe('false');
  const body = el.querySelector(`#${CSS.escape(button.getAttribute('aria-controls')!)}`) as HTMLElement;
  expect(body.hidden).toBe(true);
  expect(button.textContent).toContain('Answer');
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
  act(() => riskRow!.click());
  expect(el.querySelector('[data-context-note-row="r-0"]')!.textContent).toContain('your rule “Anything in billing.”');
  act(() => pictureRow!.click());
  act(() => el.querySelector<HTMLButtonElement>('[data-context-note-open-picture]')!.click());
  expect(opened).toEqual(['b1']);
});
