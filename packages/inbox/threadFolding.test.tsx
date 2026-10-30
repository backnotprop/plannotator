/**
 * Folding a thread as the window draws it (design record, not in this repo;
 * variant "Land"): which messages fold to one line and which stay open, what a
 * folded line says, the middle fold of a long read run, where the thread
 * opens, the "↓ N new" pill, the keys, and how long "New" lasts. happy-dom
 * has no layout, so where a test needs positions it gives the elements some.
 * The real browser proof is tests/e2e/inbox-thread-folding.spec.ts.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { InboxAuthor, InboxMessageWire, InboxProject, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';
import { sized, tooltipOf } from './testing/tooltip';

const hasDom = typeof document !== 'undefined';
// Viewer pulls in web-highlighter, which reads `window` at module-eval time.
const { ThreadPane } = (hasDom ? await import('./components/Thread') : {}) as typeof import('./components/Thread');

const PROJECT: InboxProject = { id: 'prj_1', key: 'docs-site-abcdef', name: 'docs-site', root: '/work/docs-site', created_at: '2026-10-10T09:00:00.000Z' };
const AGENT: InboxAuthor = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: 'Claude Code' };
const PERSON: InboxAuthor = { kind: 'person' };
const ROOT = 'msg_A1';

const ASK = [
  'I looked at three ways to add search to the docs site.',
  '',
  ':::question',
  'Which search index should the docs site use?',
  '',
  '- [ ] Pagefind',
  '- [ ] Orama',
  ':::',
  '',
  ':::question-multi',
  'Which sections go in the index?',
  '',
  '- [ ] Guides',
  '- [ ] API reference',
  ':::',
].join('\n');

const ONE_OPEN = [
  'Pagefind is wired in. Here is the plan.',
  '',
  ':::question',
  'Which shortcut opens search?',
  '',
  '- [ ] / and Cmd K',
  '- [ ] Cmd K only',
  ':::',
].join('\n');

const LATEST = [
  'CI is green. The index is **1.8 MB**.',
  '',
  ':::question',
  'When should the search index build?',
  '',
  '- [ ] On main and release tags',
  '- [ ] On every deploy',
  ':::',
].join('\n');

/** The answers section the store writes into a reply (core's composeInboxReplyBody). */
const ANSWERS_SECTION = '## Answers to your questions\n\n1. **Which search index should the docs site use?** Pagefind\n2. **Which sections go in the index?** Guides, API reference';

function questionsOf(messageId: string, body: string): InboxQuestion[] {
  return parseInboxQuestionBlocks(body).map((q) => ({
    key: q.key,
    position: q.position,
    kind: q.kind,
    prompt: q.prompt,
    context: q.parsed.context,
    choices: q.parsed.choices,
    recommendation: null,
    suggested_text: null,
    stopped: q.stopped,
    holds_up: q.holds_up,
    asked_by_agent_id: 'ses_a',
    orphaned: false,
    state: 'open',
    answer: null,
    revision: 0,
    sent_revision: 0,
    picked_by: null,
    picked_at: null,
    sent_reply_id: null,
    message_id: messageId,
    superseded_by: null,
  }));
}

function sentAs(q: InboxQuestion, selected: string[], replyId: string): InboxQuestion {
  return { ...q, state: 'sent', revision: 1, sent_revision: 1, sent_reply_id: replyId, answer: { v: 1, key: q.key, kind: q.kind as 'single', prompt: q.prompt, selected } };
}

function message(id: string, author: InboxAuthor, seq: number, body: string, extra: Partial<InboxMessageWire> = {}): InboxMessageWire {
  return {
    id,
    project_id: PROJECT.id,
    thread_id: ROOT,
    reply_to: id === ROOT ? null : ROOT,
    author,
    subject: id === ROOT ? 'Search for the docs site' : null,
    body,
    created_at: `2026-10-10T${String(9 + Math.floor(seq / 2)).padStart(2, '0')}:${String((seq * 7) % 60).padStart(2, '0')}:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
    seq,
    ...(author.kind === 'person' ? { sent_annotations: 0 } : {}),
    ...extra,
  };
}

/**
 * Seven messages: two questions answered, a reply, a plan with a file and an
 * answered question, a reply with two annotations, a plain note, the person's
 * last reply (read by the agent), and one message after the person's look.
 */
function seven(options: { lookAt?: number } = {}): InboxThread {
  const [index, sections] = questionsOf(ROOT, ASK);
  const [shortcut] = questionsOf('msg_A2', ONE_OPEN);
  const messages = [
    message(ROOT, AGENT, 2, ASK, {
      questions: [sentAs(index!, ['Pagefind'], 'msg_P1'), sentAs(sections!, ['Guides', 'API reference'], 'msg_P1')],
      person_seen_seq: options.lookAt ?? 11,
      agent_checked_seq: 13,
    }),
    message('msg_P1', PERSON, 5, `Answered 2 questions.\n\nPagefind is fine. Keep the blog out for now.\n\n${ANSWERS_SECTION}`),
    message('msg_A2', AGENT, 7, ONE_OPEN, {
      questions: [sentAs(shortcut!, ['/ and Cmd K'], 'msg_P2')],
      attachments: [{ id: 'att_1', path: '/work/docs-site/plan.md', named_path: null, kind: 'markdown', sent_sha256: '0'.repeat(64), size: 10, sent_at: '2026-10-10T12:00:00.000Z', sent_mtime: '2026-10-10T12:00:00.000Z' } as never],
    }),
    message('msg_P2', PERSON, 9, 'Answered 1 question. The plan is close. Two notes on the file.', { sent_annotations: 2 }),
    message('msg_A3', AGENT, 11, 'Both notes are in: **results** show the [section path](https://example.com). Ready for a read.'),
    message('msg_P3', PERSON, 13, 'Read it, looks good. One thing: an empty result says only "No results".'),
    message('msg_A4', AGENT, 15, LATEST, { questions: questionsOf('msg_A4', LATEST) }),
  ];
  return { thread_id: ROOT, project: PROJECT, subject: 'Search for the docs site', thread_name: null, resolved_at: null, messages };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;
const restore: (() => void)[] = [];

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (init?.method === 'POST') return Response.json({ questions: [] });
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ home: null, project: PROJECT, sessions: [] });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  for (const undo of restore.splice(0).reverse()) undo();
});

/** Override a prototype property for this test only. */
function stub<T extends object>(target: T, key: string, descriptor: PropertyDescriptor) {
  const saved = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  restore.push(() => (saved ? Object.defineProperty(target, key, saved) : delete (target as Record<string, unknown>)[key]));
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Let `ms` pass inside act. The live region and a jump land from timers the
 * pane sets (the announcement 30 ms after the click, the jump on the next
 * frame); inside act their state updates are flushed before act returns. A
 * plain wait outside act only works when the runner keeps up: under load both
 * timers fire in one turn and the test reads the DOM before React renders the
 * update the first one queued.
 */
async function waitInAct(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

function pane(thread: InboxThread, lookSeq?: number | null) {
  return (
    <div className="pn-inbox">
      <ThreadPane
        thread={thread}
        sent={null}
        onQuestions={() => {}}
        onChanged={async () => {}}
        onClose={() => {}}
        file={null}
        onOpenFile={() => {}}
        onOpenGuide={() => {}}
        lookSeq={lookSeq}
      />
    </div>
  );
}

async function render(thread: InboxThread, lookSeq?: number | null) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(pane(thread, lookSeq));
  });
  await settle();
  return host;
}

const article = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-message-article="${id}"]`);
const shown = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('.ib-pbody > [data-message-article], .ib-pbody > [data-middle-fold], .ib-pbody > [data-new-divider]')].map((node) =>
  node.hasAttribute('data-middle-fold') ? 'fold' : node.hasAttribute('data-new-divider') ? 'divider' : `${node.getAttribute('data-message-article')}:${node.hasAttribute('data-folded') ? 'line' : 'open'}`,
);
const holdings = (el: HTMLElement, id: string) => [...(article(el, id)?.querySelectorAll('[data-holding]') ?? [])].map((h) => `${h.getAttribute('data-holding')}=${h.textContent}`);
const focusedArticle = () => (document.activeElement as HTMLElement | null)?.closest('[data-message-article], [data-middle-fold]');
const key = (k: string, target: EventTarget = document.body) => act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })));
const shift = (k: string, target: EventTarget = document.body) => act(() => void target.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: true, bubbles: true, cancelable: true })));

test.skipIf(!hasDom)('read messages fold to lines; the new, the last and one holding an unsent pick stay open; the middle of the read run hides', async () => {
  const el = await render(seven());
  // The read run A1..P3 keeps its first and last two; the new last message is open under the divider.
  expect(shown(el)).toEqual(['msg_A1:line', 'fold', 'msg_A3:line', 'msg_P3:line', 'divider', 'msg_A4:open']);
  expect(el.querySelector('[data-middle-fold]')!.textContent).toBe('3 earlier messages');
  expect(el.querySelector('[data-new-divider]')!.textContent).toBe('New since you looked');
  expect(article(el, 'msg_A4')!.hasAttribute('data-new')).toBe(true);
  expect(article(el, 'msg_A4')!.querySelector('.ib-newtag')!.textContent).toBe('New');
  expect(el.querySelector('[data-thread-meta]')!.textContent).toContain('7 messages');
  expect(el.querySelector('[data-thread-meta]')!.textContent).toContain('1 new since you looked');
  expect(el.querySelector('[data-expand-all]')!.getAttribute('aria-label')).toBe('Expand all messages');
  // Every folded line and every open header is a button that says whether it is open.
  expect(article(el, 'msg_A1')!.querySelector('[data-fold-head]')!.getAttribute('aria-expanded')).toBe('false');
  expect(article(el, 'msg_A4')!.querySelector('[data-fold-head]')!.getAttribute('aria-expanded')).toBe('true');

  // A message holding a pick not sent stays open though it was read and is not the last.
  const thread = seven();
  const a3 = thread.messages[4]!;
  const [q] = questionsOf('msg_A3', ONE_OPEN);
  thread.messages[4] = { ...a3, body: ONE_OPEN, questions: [{ ...q!, message_id: 'msg_A3', state: 'picked', answer: { v: 1, key: q!.key, kind: q!.kind as 'single', prompt: q!.prompt, selected: ['Cmd K only'] }, picked_at: '2026-10-10T13:00:00.000Z' }] };
  act(() => root!.unmount());
  host!.remove();
  const again = await render(thread);
  // The read run before it is four long now: the first and last two stay, one message hides.
  expect(shown(again)).toEqual(['msg_A1:line', 'fold', 'msg_A2:line', 'msg_P2:line', 'msg_A3:open', 'msg_P3:line', 'divider', 'msg_A4:open']);
  expect(again.querySelector('[data-middle-fold]')!.textContent).toBe('1 earlier message');
  // Folded by hand, its line says the pick is not sent.
  act(() => (article(again, 'msg_A3')!.querySelector('[data-fold-head]') as HTMLButtonElement).click());
  expect(holdings(again, 'msg_A3')).toEqual(['picks=1 pick in your draft']);
});

test.skipIf(!hasDom)("a folded line's snippet is the person's answers when every question is answered, else the message's first words; and it says what the message holds", async () => {
  const el = await render(seven());
  act(() => (el.querySelector('[data-middle-fold] button') as HTMLButtonElement).click());
  const snippet = (id: string) => article(el, id)!.querySelector('[data-snippet]')!;
  expect(snippet('msg_A1').getAttribute('data-snippet')).toBe('answers');
  // A prompt over 40 characters is cut at a word, so the answer stays on the line; the whole prompt is in the tooltip while the line is cut.
  expect(snippet('msg_A1').textContent).toBe('Which search index should the docs site… → Pagefind · Which sections go in the index → Guides, API reference');
  sized(snippet('msg_A1'), 600, 200);
  expect(await tooltipOf(snippet('msg_A1'))).toBe('Which search index should the docs site use: Pagefind; Which sections go in the index: Guides, API reference');
  expect(snippet('msg_A3').getAttribute('data-snippet')).toBe('words');
  // Markdown marks gone, link text kept.
  expect(snippet('msg_A3').textContent).toBe('Both notes are in: results show the section path. Ready for a read.');
  // A reply: the person's own words, without the store's "Answered 2 questions." and the answers section.
  expect(snippet('msg_P1').textContent).toBe('Pagefind is fine. Keep the blog out for now.');
  expect(holdings(el, 'msg_A1')).toEqual(['answered=2 answered']);
  expect(holdings(el, 'msg_A2')).toEqual(['answered=1 answered', 'files=1']);
  expect(holdings(el, 'msg_P2')).toEqual(['annotations=2', 'delivered=Delivered']);
  expect(holdings(el, 'msg_P3')).toEqual(['delivered=Delivered']);
  // The line's label reads the sender, the time, what it holds and the snippet.
  expect(article(el, 'msg_A1')!.querySelector('[data-fold-head]')!.getAttribute('aria-label')).toMatch(/^Claude Code, (?:[A-Z][a-z]{2} \d{1,2}, (?:\d{4}, )?)?\d{1,2}:\d{2} [AP]M\. 2 questions answered\. Which search index should the docs site use: Pagefind; Which sections go in the index: Guides, API reference$/);

  // One question answered, one still open: the first words, and "1 open question".
  const thread = seven();
  const [index, sections] = questionsOf(ROOT, ASK);
  thread.messages[0] = { ...thread.messages[0]!, questions: [sentAs(index!, ['Pagefind'], 'msg_P1'), sections!] };
  act(() => root!.render(pane(thread)));
  expect(snippet('msg_A1').getAttribute('data-snippet')).toBe('words');
  expect(snippet('msg_A1').textContent).toBe('I looked at three ways to add search to the docs site.');
  expect(holdings(el, 'msg_A1')).toEqual(['open=1 open question']);
});

test.skipIf(!hasDom)('the middle fold opens to lines and focuses the first; Expand all opens everything; Fold all goes back to lines, keeping the last open', async () => {
  const el = await render(seven());
  act(() => (el.querySelector('[data-middle-fold] button') as HTMLButtonElement).click());
  expect(shown(el)).toEqual(['msg_A1:line', 'msg_P1:line', 'msg_A2:line', 'msg_P2:line', 'msg_A3:line', 'msg_P3:line', 'divider', 'msg_A4:open']);
  expect(focusedArticle()?.getAttribute('data-message-article')).toBe('msg_P1');
  await settle();
  await waitInAct(40);
  expect(el.querySelector('[data-fold-live]')!.textContent).toBe('3 earlier messages shown');

  act(() => (el.querySelector('[data-expand-all]') as HTMLButtonElement).click());
  expect(shown(el)).toEqual(['msg_A1:open', 'msg_P1:open', 'msg_A2:open', 'msg_P2:open', 'msg_A3:open', 'msg_P3:open', 'divider', 'msg_A4:open']);
  expect(el.querySelector('[data-expand-all]')!.getAttribute('aria-label')).toBe('Fold the earlier messages');
  expect(article(el, 'msg_A1')!.querySelector('[data-message-id="msg_A1"]')).not.toBeNull();

  act(() => (el.querySelector('[data-expand-all]') as HTMLButtonElement).click());
  expect(shown(el)).toEqual(['msg_A1:line', 'fold', 'msg_A3:line', 'msg_P3:line', 'divider', 'msg_A4:open']);
  expect(el.querySelector('[data-expand-all]')!.getAttribute('aria-label')).toBe('Expand all messages');
});

test.skipIf(!hasDom)('opening a line keeps it where it was: the scroll moves by however much the thread above it changed', async () => {
  const el = await render(seven());
  const body = el.querySelector<HTMLElement>('.ib-pbody')!;
  // A layout: at a scroll of 100 the line sits at 300; opened, the thread above it grows and it would land at 340.
  stub(HTMLElement.prototype, 'getBoundingClientRect', {
    value(this: HTMLElement) {
      const y = this.getAttribute('data-message-article') === 'msg_A3' ? (this.hasAttribute('data-open') ? 340 : 300) - (body.scrollTop - 100) : 0;
      return { top: y, bottom: y + 40, left: 0, right: 0, width: 0, height: 40, x: 0, y, toJSON() {} };
    },
  });
  body.scrollTop = 100;
  const line = article(el, 'msg_A3')!.querySelector<HTMLButtonElement>('[data-fold-head]')!;
  act(() => line.click());
  // The scroll moves 40 down, so the message stays at 300.
  expect(body.scrollTop).toBe(140);
  expect(article(el, 'msg_A3')!.hasAttribute('data-open')).toBe(true);
  // Focus stays on the message the person opened (its header now).
  expect(document.activeElement).toBe(article(el, 'msg_A3')!.querySelector('[data-fold-head]'));
});

test.skipIf(!hasDom)("a message's head is one row folded or open: the mark, the name and the time keep their cells; only the third column swaps, and only a body the person opened fades in", async () => {
  const el = await render(seven());
  const cells = (row: Element) => [...row.querySelectorAll(':scope > *, :scope > .ib-a11y-skip > *')].map((c) => c.className).filter((c) => c !== 'ib-a11y-skip' && c !== 'ib-fl-hit');
  const folded = article(el, 'msg_A3')!.querySelector('.ib-fline')!;
  const foldedMark = folded.querySelector('.ib-mk')!.className;
  const foldedName = folded.querySelector('.ib-fl-nm')!.textContent;
  expect(cells(folded)).toEqual(['ib-mk ib-big', 'ib-fl-nm', 'ib-fl-sn', 'ib-fl-chips', 'ib-fl-tm']);

  act(() => article(el, 'msg_A3')!.querySelector<HTMLButtonElement>('[data-fold-head]')!.click());
  const open = article(el, 'msg_A3')!.querySelector('[data-open-head]')!;
  // The same row: the mark the same size (its classes), the name in the same cell, the snippet's column now
  // says where it was sent and to whom, the time last.
  expect(open.classList.contains('ib-fline')).toBe(true);
  expect(cells(open)).toEqual(['ib-mk ib-big', 'ib-fl-nm ib-who', 'ib-fl-meta', 'ib-fl-chips', 'ib-fl-tm']);
  expect(open.querySelector('.ib-mk')!.className).toBe(foldedMark);
  expect(open.querySelector('.ib-fl-nm')!.textContent).toBe(foldedName);
  expect(open.querySelector('.ib-fl-meta')!.textContent).toBe('in docs-site · to you');
  // The fold button lies under the row; the row's text is its label's, hidden from screen readers.
  const hit = open.querySelector('.ib-fl-hit')!;
  expect(hit.getAttribute('data-fold-head')).toBe('');
  expect(hit.getAttribute('aria-expanded')).toBe('true');
  expect(open.querySelector('.ib-fl-nm')!.getAttribute('aria-hidden')).toBe('true');
  // The body the person opened fades in; one open from the first draw does not.
  expect(article(el, 'msg_A3')!.querySelector('.ib-msg')!.hasAttribute('data-revealed')).toBe(true);
  expect(article(el, 'msg_A4')!.querySelector('.ib-msg')!.hasAttribute('data-revealed')).toBe(false);
  // Folding is instant, and the line is the folded row again.
  act(() => (hit as HTMLButtonElement).click());
  expect(cells(article(el, 'msg_A3')!.querySelector('.ib-fline')!)).toEqual(['ib-mk ib-big', 'ib-fl-nm', 'ib-fl-sn', 'ib-fl-chips', 'ib-fl-tm']);
});

test.skipIf(!hasDom)('the thread opens at the divider with the last read line above it; with nothing new it opens at the top', async () => {
  // Every top-level element of the thread is 50px under the one before it.
  stub(HTMLElement.prototype, 'offsetTop', {
    get(this: HTMLElement) {
      const parent = this.parentElement;
      return parent?.classList.contains('ib-pbody') ? [...parent.children].indexOf(this) * 50 : 0;
    },
  });
  const el = await render(seven());
  const body = el.querySelector<HTMLElement>('.ib-pbody')!;
  const divider = el.querySelector<HTMLElement>('[data-new-divider]')!;
  const above = divider.previousElementSibling as HTMLElement;
  expect(above.getAttribute('data-message-article')).toBe('msg_P3');
  expect(body.scrollTop).toBe(above.offsetTop - 6);

  act(() => root!.unmount());
  host!.remove();
  const read = await render(seven({ lookAt: 15 }));
  expect(read.querySelector('[data-new-divider]')).toBeNull();
  expect(read.querySelector('.ib-newtag')).toBeNull();
  expect(read.querySelector('[data-thread-meta]')!.textContent).not.toContain('new since you looked');
  expect(read.querySelector<HTMLElement>('.ib-pbody')!.scrollTop).toBe(0);
});

test.skipIf(!hasDom)('the "↓ 1 new" pill shows while the first new message is below the view, and goes to it', async () => {
  let newTop = 2000;
  stub(HTMLElement.prototype, 'getBoundingClientRect', {
    value(this: HTMLElement) {
      const y = this.classList.contains('ib-pbody') ? 0 : this.hasAttribute('data-new') ? newTop : this.classList.contains('ib-subject') ? 20 : 0;
      const h = this.classList.contains('ib-pbody') ? 800 : 40;
      return { top: y, bottom: y + h, left: 0, right: 0, width: 0, height: h, x: 0, y, toJSON() {} };
    },
  });
  const scrolled: string[] = [];
  stub(HTMLElement.prototype, 'scrollIntoView', {
    value(this: HTMLElement) {
      scrolled.push(this.hasAttribute('data-new-divider') ? 'divider' : (this.getAttribute('data-message-article') ?? this.className));
    },
  });
  const el = await render(seven());
  const pill = el.querySelector<HTMLButtonElement>('[data-new-pill]')!;
  expect(pill.textContent).toBe('1 new');
  expect(pill.hasAttribute('data-off')).toBe(false);
  act(() => pill.click());
  expect(scrolled).toContain('divider');
  expect(document.activeElement).toBe(article(el, 'msg_A4')!.querySelector('[data-fold-head]'));
  // Scrolled down to it, the pill goes.
  newTop = 300;
  act(() => void el.querySelector('.ib-pbody')!.dispatchEvent(new Event('scroll')));
  expect(pill.hasAttribute('data-off')).toBe(true);
});

test.skipIf(!hasDom)('keys: n goes to the first new message, Shift+J and Shift+K move between messages and the fold; never while typing', async () => {
  const el = await render(seven());
  key('n');
  expect(focusedArticle()?.getAttribute('data-message-article')).toBe('msg_A4');
  shift('K');
  expect(focusedArticle()?.getAttribute('data-message-article')).toBe('msg_P3');
  shift('K');
  shift('K');
  expect(focusedArticle()?.hasAttribute('data-middle-fold')).toBe(true);
  shift('K');
  expect(focusedArticle()?.getAttribute('data-message-article')).toBe('msg_A1');
  shift('K');
  expect(focusedArticle()?.getAttribute('data-message-article')).toBe('msg_A1');
  shift('J');
  shift('J');
  expect(focusedArticle()?.getAttribute('data-message-article')).toBe('msg_A3');
  // In the reply box the letters are text.
  act(() => ([...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Reply') as HTMLButtonElement).click());
  const box = el.querySelector('textarea')!;
  box.focus();
  key('n', box);
  shift('J', box);
  expect(document.activeElement).toBe(box);
});

test.skipIf(!hasDom)('"New" lasts until the person leaves the thread: the thread read again after the look keeps the marks; reopened, nothing is new', async () => {
  // As the window does it: the boundary from the first read, the thread read again after /seen.
  const el = await render(seven(), 13);
  act(() => root!.render(pane(seven({ lookAt: 15 }), 13)));
  expect(article(el, 'msg_A4')!.hasAttribute('data-new')).toBe(true);
  expect(el.querySelector('[data-new-divider]')).not.toBeNull();
  // A message that arrives while the thread is open shows open, new, at the bottom; nothing above moves.
  const grown = seven({ lookAt: 15 });
  grown.messages.push(message('msg_A5', AGENT, 17, 'Merged.'));
  act(() => root!.render(pane(grown, 13)));
  expect(shown(el)).toEqual(['msg_A1:line', 'fold', 'msg_A3:line', 'msg_P3:line', 'divider', 'msg_A4:open', 'msg_A5:open']);
  expect(article(el, 'msg_A5')!.hasAttribute('data-new')).toBe(true);
  expect(el.querySelector('[data-thread-meta]')!.textContent).toContain('2 new since you looked');
  // Left and opened again: the boundary is read again, after the look.
  act(() => root!.unmount());
  host!.remove();
  const seenAll: InboxThread = { ...grown, messages: grown.messages.map((m, i) => (i === 0 ? { ...m, person_seen_seq: 17 } : m)) };
  const reopened = await render(seenAll);
  expect(reopened.querySelector('[data-message-article][data-new]')).toBeNull();
  expect(reopened.querySelector('[data-new-pill]')).toBeNull();
});

test.skipIf(!hasDom)('a one-message thread looks as it always did: no fold button, no New, no meta line, no Expand all', async () => {
  const thread = seven();
  const one: InboxThread = { ...thread, messages: [{ ...thread.messages[0]!, person_seen_seq: 0 }] };
  const el = await render(one);
  expect(el.querySelector('[data-fold-head]')).toBeNull();
  expect(el.querySelector('[data-expand-all]')).toBeNull();
  expect(el.querySelector('[data-thread-meta]')).toBeNull();
  expect(el.querySelector('.ib-newtag')).toBeNull();
  expect(el.querySelector('[data-new-pill]')).toBeNull();
  expect(el.querySelector('.ib-pbody')!.classList.contains('ib-folding')).toBe(false);
  // The same head row as every other message (inbox-polish, item 5), with nothing to fold.
  const head = article(el, ROOT)!.querySelector('[data-open-head]')!;
  expect(head.classList.contains('ib-fline')).toBe(true);
  expect(head.querySelector('.ib-who')!.textContent).toBe('Claude Code');
  expect(head.querySelector('.ib-fl-meta')!.textContent).toBe('in docs-site · to you');
  expect(head.querySelector('.ib-fl-nm')!.hasAttribute('aria-hidden')).toBe(false);
  expect(head.querySelector('.ib-fl-in')!.hasAttribute('aria-hidden')).toBe(false);
});

test.skipIf(!hasDom)('a payload without seqs (an older Inbox) folds nothing and marks nothing new', async () => {
  const thread = seven();
  const old: InboxThread = { ...thread, messages: thread.messages.map(({ seq: _seq, ...rest }) => rest) };
  const el = await render(old);
  expect(el.querySelector('[data-folded]')).toBeNull();
  expect(el.querySelector('[data-new]')).toBeNull();
  expect(el.querySelectorAll('[data-message-article][data-open]').length).toBe(7);
});

test.skipIf(!hasDom)('a link to a replaced card in a folded message opens the message, then lands on the card', async () => {
  const thread = seven();
  const [index, sections] = questionsOf(ROOT, ASK);
  const [latest] = questionsOf('msg_A4', LATEST);
  thread.messages[0] = { ...thread.messages[0]!, questions: [{ ...index!, state: 'superseded', superseded_by: { message_id: 'msg_A4', key: latest!.key } }, sentAs(sections!, ['Guides'], 'msg_P1')] };
  const el = await render(thread);
  expect(article(el, ROOT)!.hasAttribute('data-folded')).toBe(true);
  const link = article(el, 'msg_A4')!.querySelector<HTMLButtonElement>('[data-replaces-line] .ib-q-link')!;
  act(() => link.click());
  await settle();
  await waitInAct(40);
  expect(article(el, ROOT)!.hasAttribute('data-open')).toBe(true);
  expect(document.activeElement?.getAttribute('data-question-key')).toBe(index!.key);
});

test.skipIf(!hasDom)('a reply the person sends during the visit is a look: everything above it stops being new (marks, divider, pill, meta, Fold all)', async () => {
  // The window's boundary from before this look: msg_A4 is new.
  const el = await render(seven(), 13);
  expect(article(el, 'msg_A4')!.hasAttribute('data-new')).toBe(true);
  // The person answers it; the thread is read again with their reply at the bottom.
  const answered = seven({ lookAt: 15 });
  answered.messages.push(message('msg_P4', PERSON, 16, 'On main and release tags.'));
  act(() => root!.render(pane(answered, 13)));
  expect(el.querySelector('[data-message-article][data-new]')).toBeNull();
  expect(el.querySelector('.ib-newtag')).toBeNull();
  expect(el.querySelector('[data-new-divider]')).toBeNull();
  expect(el.querySelector('[data-new-pill]')).toBeNull();
  expect(el.querySelector('[data-thread-meta]')!.textContent).not.toContain('new since you looked');
  // Folded, the lines above the reply are not drawn as unread either.
  act(() => (el.querySelector('[data-expand-all]') as HTMLButtonElement).click());
  act(() => (el.querySelector('[data-expand-all]') as HTMLButtonElement).click());
  expect(el.querySelector('[data-expand-all]')!.getAttribute('aria-label')).toBe('Expand all messages');
  expect(el.querySelector('.ib-fl-unread')).toBeNull();
  expect(el.querySelector('.ib-newtag')).toBeNull();
  // The agent writes again after the reply: that one is new.
  act(() => root!.render(pane({ ...answered, messages: [...answered.messages, message('msg_A5', AGENT, 18, 'Done.')] }, 13)));
  expect([...el.querySelectorAll('[data-message-article][data-new]')].map((a) => a.getAttribute('data-message-article'))).toEqual(['msg_A5']);
});

test.skipIf(!hasDom)('a reply with no words of its own shows the answers it sent; a message that is only a question shows the question', async () => {
  const thread = seven();
  const only = ':::question\nWhich **shortcut** opens `search`?\n\n- [ ] /\n- [ ] Cmd K\n:::';
  thread.messages[1] = { ...thread.messages[1]!, body: `Answered 2 questions.\n\n${ANSWERS_SECTION}` };
  thread.messages[4] = { ...thread.messages[4]!, body: only, questions: questionsOf('msg_A3', only) };
  const el = await render(thread);
  act(() => (el.querySelector('[data-middle-fold] button') as HTMLButtonElement).click());
  const reply = article(el, 'msg_P1')!.querySelector('[data-snippet]')!;
  expect(reply.getAttribute('data-snippet')).toBe('answers');
  expect(reply.textContent).toBe('Which search index should the docs site… → Pagefind · Which sections go in the index → Guides, API reference');
  expect(article(el, 'msg_A3')!.querySelector('[data-snippet]')!.textContent).toBe('Which shortcut opens search');
});

test.skipIf(!hasDom)('the meta line says one time when the thread began and ended in the same minute; nothing inside a fold button is a div', async () => {
  const thread = seven();
  const at = thread.messages[0]!.created_at;
  const el = await render({ ...thread, messages: thread.messages.map((m) => ({ ...m, created_at: at })) });
  const span = el.querySelectorAll('[data-thread-meta-rest] > span')[2]!.textContent!;
  expect(span).not.toContain(' to ');
  expect(span).toMatch(/\d{1,2}:\d{2} [AP]M$/);
  expect(el.querySelectorAll('button div').length).toBe(0);
});

test.skipIf(!hasDom)('the pill shows while ANY new message is below the view, and goes to the first one below', async () => {
  const grown = seven();
  grown.messages.push(message('msg_A5', AGENT, 17, 'Merged.'));
  stub(HTMLElement.prototype, 'getBoundingClientRect', {
    value(this: HTMLElement) {
      const id = this.getAttribute('data-message-article');
      const y = this.classList.contains('ib-pbody') ? 0 : id === 'msg_A4' ? 300 : id === 'msg_A5' ? 2000 : 0;
      const h = this.classList.contains('ib-pbody') ? 800 : 40;
      return { top: y, bottom: y + h, left: 0, right: 0, width: 0, height: h, x: 0, y, toJSON() {} };
    },
  });
  const scrolled: string[] = [];
  stub(HTMLElement.prototype, 'scrollIntoView', {
    value(this: HTMLElement) {
      scrolled.push(this.hasAttribute('data-new-divider') ? 'divider' : (this.getAttribute('data-message-article') ?? this.className));
    },
  });
  const el = await render(grown);
  const pill = el.querySelector<HTMLButtonElement>('[data-new-pill]')!;
  // The first new message is in view, the second is not: the pill counts what
  // is below the view (it used to print every new message of the visit, "2 new";
  // design record "inbox-new-in-open-thread").
  expect(pill.textContent).toBe('1 new');
  expect(pill.hasAttribute('data-off')).toBe(false);
  act(() => pill.click());
  expect(scrolled.at(-1)).toBe('msg_A5');
  expect(document.activeElement).toBe(article(el, 'msg_A5')!.querySelector('[data-fold-head]'));
});

test.skipIf(!hasDom)('typing in the reply box measures nothing: the chrome and the anchor follow folds and the thread, not keystrokes', async () => {
  const el = await render(seven());
  act(() => ([...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Reply') as HTMLButtonElement).click());
  const box = el.querySelector('textarea')!;
  let measured = 0;
  stub(HTMLElement.prototype, 'getBoundingClientRect', {
    value(this: HTMLElement) {
      if (this.classList.contains('ib-pbody')) measured += 1;
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} };
    },
  });
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  for (const text of ['O', 'On', 'On m']) {
    act(() => {
      setValue.call(box, text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  expect(box.value).toBe('On m');
  expect(measured).toBe(0);
});

test.skipIf(!hasDom)('the thread box changing size (the reply box opening or closing below it) re-measures the pill without a scroll or a window resize; a message once on screen never brings it back', async () => {
  // A fake ResizeObserver the test drives, standing in for the browser's.
  const observers: { callback: ResizeObserverCallback; observed: Element[]; connected: boolean }[] = [];
  stub(globalThis, 'ResizeObserver', {
    writable: true,
    value: class {
      private entry: (typeof observers)[number];
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, observed: [], connected: true };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.observed.push(target);
      }
      unobserve() {}
      disconnect() {
        this.entry.connected = false;
      }
    },
  });
  // The new message's top is at 700; the thread box ends at 600 while the reply box is open, at 800 once it closes.
  let bottom = 600;
  stub(HTMLElement.prototype, 'getBoundingClientRect', {
    value(this: HTMLElement) {
      const y = this.classList.contains('ib-pbody') ? 0 : this.hasAttribute('data-new') ? 700 : 0;
      const h = this.classList.contains('ib-pbody') ? bottom : 40;
      return { top: y, bottom: y + h, left: 0, right: 0, width: 0, height: h, x: 0, y, toJSON() {} };
    },
  });
  const el = await render(seven());
  const body = el.querySelector('.ib-pbody')!;
  const watcher = observers.find((o) => o.observed.includes(body))!;
  expect(watcher).toBeDefined();
  const pill = el.querySelector<HTMLButtonElement>('[data-new-pill]')!;
  expect(pill.hasAttribute('data-off')).toBe(false);
  bottom = 800;
  act(() => watcher.callback([], {} as ResizeObserver));
  expect(pill.hasAttribute('data-off')).toBe(true);
  // The reply box opens again and covers it: it was on screen, so the pill stays away.
  bottom = 600;
  act(() => watcher.callback([], {} as ResizeObserver));
  expect(pill.hasAttribute('data-off')).toBe(true);
  act(() => root!.unmount());
  root = null;
  expect(watcher.connected).toBe(false);
});

// The Inbox's own notes (Mark read's set-aside note, a late Undo's reopened
// note) are written as the person's messages but are not the person's reply
// and not a look (violation A in adr/implementation/inbox-thread-state.md).
// The failures these guard: the "Saved for / Delivered to" line moved under the
// note (or vanished, the row's `sent` being the reply's), and an agent message
// posted inside the Undo window stopped reading New once the note went.
const SET_ASIDE_NOTE = "Set aside for now; don't wait on these:\n\n- Q1. Which shortcut opens search?";

async function renderWithSent(thread: InboxThread, sent: { at: string; checked_at: string | null } | null, lookSeq?: number | null) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(
      <div className="pn-inbox">
        <ThreadPane
          thread={thread}
          sent={sent}
          onQuestions={() => {}}
          onChanged={async () => {}}
          onClose={() => {}}
          file={null}
          onOpenFile={() => {}}
          onOpenGuide={() => {}}
          lookSeq={lookSeq}
        />
      </div>,
    );
  });
  await settle();
  return host;
}

test.skipIf(!hasDom)("a reply, then the Inbox's set-aside note: the Saved for / Delivered to line sits on the reply, never on the note", async () => {
  const [q] = questionsOf(ROOT, ONE_OPEN);
  const thread: InboxThread = {
    thread_id: ROOT,
    project: PROJECT,
    subject: 'Search for the docs site',
    thread_name: null,
    resolved_at: null,
    messages: [
      message(ROOT, AGENT, 2, ONE_OPEN, { questions: [{ ...q!, state: 'closed', set_aside_at: '2026-10-10T12:00:00.000Z' } as InboxQuestion], person_seen_seq: 2 }),
      message('msg_P1', PERSON, 5, 'Still thinking about the shortcut.'),
      message('msg_N1', PERSON, 7, SET_ASIDE_NOTE, { set_aside: [`${ROOT}/${q!.key}`] }),
    ],
  };
  const saved = await renderWithSent(thread, { at: thread.messages[1]!.created_at, checked_at: null });
  // The reply stays open with the note after it, so its line shows.
  expect(shown(saved)).toEqual(['msg_A1:line', 'msg_P1:open', 'msg_N1:open']);
  expect(article(saved, 'msg_P1')!.querySelector('[data-delivery]')?.textContent).toContain('Saved for');
  expect(article(saved, 'msg_N1')!.querySelector('[data-delivery]')).toBeNull();
  act(() => root!.unmount());
  host!.remove();
  const delivered = await renderWithSent(thread, { at: thread.messages[1]!.created_at, checked_at: '2026-10-10T13:00:00.000Z' });
  expect(article(delivered, 'msg_P1')!.querySelector('[data-delivery]')?.textContent).toContain('Delivered to');
  expect(article(delivered, 'msg_N1')!.querySelector('[data-delivery]')).toBeNull();
});

test.skipIf(!hasDom)('an agent message posted inside the Undo window still reads New after the set-aside note; the visit boundary ignores the note', async () => {
  const [q] = questionsOf(ROOT, ONE_OPEN);
  const thread: InboxThread = {
    thread_id: ROOT,
    project: PROJECT,
    subject: 'Search for the docs site',
    thread_name: null,
    resolved_at: null,
    messages: [
      // Mark read counted the look at the question (seq 2); the news (4) came inside the Undo window; the note (6) after.
      message(ROOT, AGENT, 2, ONE_OPEN, { questions: [{ ...q!, state: 'closed', set_aside_at: '2026-10-10T12:00:00.000Z' } as InboxQuestion], person_seen_seq: 2 }),
      message('msg_A2', AGENT, 4, 'CI is green. The index is 1.8 MB.'),
      message('msg_N1', PERSON, 6, SET_ASIDE_NOTE, { set_aside: [`${ROOT}/${q!.key}`] }),
    ],
  };
  // The boundary read from the thread (lookBoundary): the note is no look.
  const fromThread = await renderWithSent(thread, null);
  expect(article(fromThread, 'msg_A2')!.hasAttribute('data-new')).toBe(true);
  expect(fromThread.querySelector('[data-thread-meta]')!.textContent).toContain('1 new since you looked');
  // No reply line under the note: it is not the person's reply.
  expect(fromThread.querySelector('[data-delivery]')).toBeNull();
  act(() => root!.unmount());
  host!.remove();
  // The window's look from before this visit (lookSeq): the visit boundary takes the person's replies, not the note.
  const fromVisit = await renderWithSent(thread, null, 2);
  expect(article(fromVisit, 'msg_A2')!.hasAttribute('data-new')).toBe(true);
  expect(fromVisit.querySelector('[data-new-divider]')).not.toBeNull();
});
