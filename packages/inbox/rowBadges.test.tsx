/**
 * What waits on the person at a list row's end, and the hover card of a
 * blocked row (approvals "inbox-row-badges", 2026-10-25, card A; and
 * "inbox-question-mark", 2026-11-08, Take 3 "Fill steps"):
 *
 *  - One question mark, `?N` (open questions), and the action box (open
 *    action items), each in one of three fill steps in today's theme colours:
 *    open (unfilled `?N`, the neutral action pill), holding up work (the amber
 *    tint pill, `.ib-b-hold`), stopped on you (the red tint pill,
 *    `.ib-b-stop`). No triangle badge.
 *  - Each mark's words: "3 questions", "Holding up work: 5 questions",
 *    "Stopped on you: 1 action item"; the face draws 99+, the words keep the
 *    exact count.
 *  - Card A opens on a filled mark after the tooltip delay and while the row
 *    has keyboard focus: a header (the bubble, or the box when only an action
 *    item blocks), one row per item, Q labels only when the items come from
 *    more than one question, a footer with the agent and the time.
 *  - The row's name stays short; the card's words ride aria-describedby.
 *  - Beside a thread and on a phone the marks end line 3, after the preview;
 *    the agents' marks are on line 1. A phone draws the marks alone: no card.
 *
 * happy-dom matches `:focus-visible` for every focus, so a keyboard focus is
 * a plain `focus()` here; a click's focus is proved in Chromium
 * (tests/e2e/inbox-row-badges.spec.ts).
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection, InboxRowWait } from '@plannotator/core/inbox-types';
import { settle, tooltipOf, unhover } from './testing/tooltip';
import { WIDE_ROW_WAIT_WORDS, badgeDescription, rowMarks, waitCardModel } from './components/RowBadge';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

function wait(key: string, position: number, stopped: string | null, holds_up: string[], message_id = 'msg_stop'): InboxRowWait {
  return { message_id, key, position, prompt: `Prompt ${key}`, stopped, holds_up };
}

function row(id: string, section: InboxListRow['section'], extra: Partial<InboxListRow> = {}): InboxListRow {
  return {
    thread_id: id,
    project_id: 'prj_a',
    subject: `Subject ${id}`,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null },
    created_at: '2026-10-10T10:00:00.000Z',
    last_at: '2026-10-10T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 2, picked: 0, stopped: section === 'stopped', holds_up: [], prompt: null },
    waiting_on_person: true,
    project: { id: 'prj_a', name: 'billing-svc' },
    thread_name: null,
    section,
    unread: true,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
    ...extra,
  };
}

const STOP = row('msg_stop', 'stopped', {
  thread_name: 'retry-worker',
  questions: { open: 2, picked: 0, stopped: true, holds_up: ['the retry worker', 'the admin retry view'], prompt: null },
  waits: [wait('q-11111111', 0, 'the retry worker cannot ship without this.', []), wait('q-22222222', 1, null, ['the retry worker', 'the admin retry view.'])],
});
const HOLD = row('msg_hold', 'holding', {
  thread_name: 'install-page',
  author: { kind: 'agent', host: 'opencode', session: 'ses_b', name: null },
  questions: { open: 1, picked: 0, stopped: false, holds_up: ['the install page', 'the agent table', 'the screenshots'], prompt: null },
  waits: [wait('q-33333333', 0, null, ['the install page', 'the agent table', 'the screenshots'], 'msg_hold')],
});
const WAIT = row('msg_wait', 'waiting');
/** Two agents in one thread: their pair of marks. */
const PAIR = row('msg_pair', 'waiting', {
  participants: [
    { host: 'claude-code', session: 'ses_a' },
    { host: 'codex', session: 'ses_c' },
  ],
});
/** No badge, no thread name, no count: a phone's line under the subject holds the mark alone. */
const NEWS = row('msg_news', 'new', { questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null } });
const SECTIONS: InboxListSection[] = [
  { id: 'stopped', label: 'Stopped on you', threads: [STOP] },
  { id: 'holding', label: 'Holding up work', threads: [HOLD] },
  { id: 'waiting', label: 'Waiting on you', threads: [WAIT, PAIR] },
  { id: 'new', label: 'New since you looked', threads: [NEWS] },
];

/** Only an action item stops the agent: the action box carries it, there is no question mark. */
const ACT_STOP = row('msg_actstop', 'stopped', {
  thread_name: 'key-rotation',
  questions: { open: 1, picked: 0, stopped: true, holds_up: [], prompt: null, actions: 1 },
  waits: [wait('a-11111111', 0, 'the key rotation cannot run without a session', [], 'msg_actstop')],
});
/** An action item holds up work, the question does not: the box fills, the question mark stays open. */
const ACT_HOLD = row('msg_acthold', 'holding', {
  questions: { open: 3, picked: 0, stopped: false, holds_up: ['status-page'], prompt: null, actions: 2 },
  waits: [wait('a-22222222', 0, null, ['status-page'], 'msg_acthold')],
});
/** Two action items and a question, nothing held up. */
const ACT_OPEN = row('msg_actopen', 'waiting', { questions: { open: 3, picked: 0, stopped: false, holds_up: [], prompt: null, actions: 2 } });
/** 104 questions, three hold up work: the face draws 99+. */
const MANY = row('msg_many', 'holding', {
  questions: { open: 104, picked: 0, stopped: false, holds_up: ['r1', 'r2', 'r3'], prompt: null },
  waits: [wait('q-1', 0, null, ['r1'], 'msg_many'), wait('q-2', 1, null, ['r2'], 'msg_many'), wait('q-3', 2, null, ['r3'], 'msg_many')],
});
const MANY_OPEN = row('msg_manyopen', 'waiting', { questions: { open: 104, picked: 0, stopped: false, holds_up: [], prompt: null } });
/** A blocked row with words in place of its counts ("Answered"): it keeps its filled mark. */
const ANSWERED = row('msg_answered', 'holding', {
  answered_not_sent: true,
  questions: { open: 2, picked: 0, stopped: false, holds_up: ['deploy'], prompt: null, actions: 1 },
  waits: [wait('q-1', 0, null, ['deploy'], 'msg_answered')],
});
const STEPS: InboxListSection[] = [
  { id: 'stopped', label: 'Stopped on you', threads: [STOP, ACT_STOP] },
  { id: 'holding', label: 'Holding up work', threads: [HOLD, ACT_HOLD, MANY, ANSWERED] },
  { id: 'waiting', label: 'Waiting on you', threads: [WAIT, ACT_OPEN, MANY_OPEN] },
];

describe('each mark\'s fill step', () => {
  test('from its own waits: a question stops, an action item holds; nothing blocked, both open', () => {
    expect(rowMarks(STOP)).toEqual({ questions: 2, question: 'stop', actions: 0, action: 'open' });
    expect(rowMarks(HOLD)).toEqual({ questions: 1, question: 'hold', actions: 0, action: 'open' });
    expect(rowMarks(ACT_STOP)).toEqual({ questions: 0, question: 'open', actions: 1, action: 'stop' });
    expect(rowMarks(ACT_HOLD)).toEqual({ questions: 1, question: 'open', actions: 2, action: 'hold' });
    expect(rowMarks(ACT_OPEN)).toEqual({ questions: 1, question: 'open', actions: 2, action: 'open' });
  });

  test("the row's state always shows on a mark: an older Inbox (no waits), and a Done still in the reply draft", () => {
    expect(rowMarks({ ...STOP, waits: undefined }).question).toBe('stop');
    expect(rowMarks({ ...ACT_STOP, waits: undefined })).toEqual({ questions: 0, question: 'open', actions: 1, action: 'stop' });
    // Nothing open: the staged action item keeps the agent stopped, so the box carries it.
    const staged = row('msg_staged', 'stopped', { questions: { open: 0, picked: 0, stopped: true, holds_up: [], prompt: null, staged: 1 }, waits: [] });
    expect(rowMarks(staged)).toEqual({ questions: 0, question: 'open', actions: 1, action: 'stop' });
  });
});

describe('the card model', () => {
  test('Stopped: the reasons first, then what it also holds up; Q labels when more than one question', () => {
    const m = waitCardModel(STOP)!;
    expect(m.kind).toBe('stop');
    expect(m.title).toBe('Stopped');
    expect(m.lead).toEqual([{ label: 'Q1', text: 'The retry worker cannot ship without this' }]);
    expect(m.also).toEqual([
      { label: 'Q2', text: 'The retry worker' },
      { label: 'Q2', text: 'The admin retry view' },
    ]);
    expect(badgeDescription(STOP)).toBe('Stopped: The retry worker cannot ship without this. Also holds up: The retry worker; The admin retry view.');
  });

  test('Holds up from one question: no labels', () => {
    const m = waitCardModel(HOLD)!;
    expect(m.title).toBe('Holds up 3');
    expect(m.lead.map((i) => i.label)).toEqual([null, null, null]);
    expect(badgeDescription(HOLD)).toBe('Holds up: The install page; The agent table; The screenshots.');
  });

  test('two messages whose questions are both Q1: the card numbers them in order', () => {
    const r = { ...HOLD, waits: [wait('q-1', 0, null, ['a'], 'msg_1'), wait('q-2', 0, null, ['b'], 'msg_2')] };
    expect(waitCardModel(r)!.lead.map((i) => i.label)).toEqual(['Q1', 'Q2']);
    const actions = { ...HOLD, waits: [wait('a-1', 0, null, ['a']), wait('q-1', 0, null, ['b'])] };
    expect(waitCardModel(actions)!.lead.map((i) => i.label)).toEqual(['A1', 'Q1']);
  });

  test('a name two questions hold up is one row, naming both, so the card agrees with the badge count', () => {
    // The server's summary counts names once across questions (summarizeInboxQuestions).
    const shared = row('msg_shared', 'holding', {
      questions: { open: 2, picked: 0, stopped: false, holds_up: ['deploy', 'docs'], prompt: null },
      waits: [wait('q-1', 0, null, ['deploy']), wait('q-2', 1, null, ['deploy', 'docs'])],
    });
    const m = waitCardModel(shared)!;
    expect(m.title).toBe('Holds up 2');
    expect(m.lead).toEqual([
      { label: 'Q1, Q2', text: 'Deploy' },
      { label: 'Q2', text: 'Docs' },
    ]);
    expect(m.lead).toHaveLength(shared.questions.holds_up.length);
    expect(badgeDescription(shared)).toBe('Holds up: Deploy; Docs.');
    // One question holding up "deploy" twice (the summary drops the repeat too): one row, no label.
    const twice = row('msg_twice', 'holding', {
      questions: { open: 1, picked: 0, stopped: false, holds_up: ['deploy'], prompt: null },
      waits: [wait('q-1', 0, null, ['deploy', 'deploy'])],
    });
    expect(waitCardModel(twice)!.lead).toEqual([{ label: null, text: 'Deploy' }]);
    // A Stopped card's "Also holds up N" counts what the badge's summary counts.
    const stop = row('msg_stop2', 'stopped', {
      questions: { open: 2, picked: 0, stopped: true, holds_up: ['deploy'], prompt: null },
      waits: [wait('q-1', 0, 'the deploy', ['deploy']), wait('q-2', 1, null, ['deploy'])],
    });
    const sm = waitCardModel(stop)!;
    expect(sm.alsoTotal).toBe(stop.questions.holds_up.length);
    expect(sm.also).toEqual([{ label: 'Q1, Q2', text: 'Deploy' }]);
  });

  test('five lines, then +N more; an older Inbox (no waits) lists the merged hold-ups', () => {
    const many = { ...HOLD, waits: [wait('q-1', 0, null, ['a', 'b', 'c', 'd', 'e', 'f', 'g'])] };
    const m = waitCardModel(many)!;
    expect(m.lead).toHaveLength(5);
    expect(m.more).toBe(2);
    expect(badgeDescription(many)).toEndWith('And 2 more.');
    const older = { ...HOLD, waits: undefined };
    expect(waitCardModel(older)!.lead.map((i) => i.text)).toEqual(['The install page', 'The agent table', 'The screenshots']);
    const olderStop = { ...STOP, waits: undefined };
    expect(badgeDescription(olderStop)).toBe('Stopped: The agent cannot go on until you answer. Also holds up: The retry worker; The admin retry view.');
  });

  test('no badge, no card', () => {
    expect(waitCardModel(WAIT)).toBeNull();
    expect(badgeDescription(WAIT)).toBe('');
  });
});

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(opts: { narrow?: boolean; phone?: boolean; sections?: InboxListSection[] } = {}): HTMLElement {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  host.setAttribute('data-pn-tooltip-root', '');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <SidebarProvider>
        <InboxList
          title="Inbox"
          path={null}
          sections={opts.sections ?? SECTIONS}
          filtered={false}
          narrow={opts.narrow ?? false}
          selectedThreadId={null}
          notice={null}
          onShowNew={() => {}}
          onOpen={() => {}}
          phone={opts.phone}
        />
      </SidebarProvider>,
    ),
  );
  return host;
}

/** The open card, or null (a closing one, its popup marked data-closed, does not count: happy-dom runs no exit animation). */
const card = () =>
  [...document.querySelectorAll<HTMLElement>('[data-wait-card]')].find((c) => {
    const pop = c.closest('[data-pn-tooltip]');
    return !pop?.hasAttribute('data-closed') && !pop?.hasAttribute('data-ending-style');
  }) ?? null;

/** A row's question mark and action box, by row id; `scope` picks the row's shape. */
const qmark = (el: HTMLElement, id: string, scope = '.ib-row') => el.querySelector<HTMLElement>(`${scope}[data-thread-id="${id}"] .ib-qn`);
const abox = (el: HTMLElement, id: string, scope = '.ib-row') => el.querySelector<HTMLElement>(`${scope}[data-thread-id="${id}"] [data-action-count]`);
const said = (mark: HTMLElement | null) => mark?.querySelector('.ib-sr')!.textContent!.trim();
const face = (mark: HTMLElement | null) => mark?.querySelector('.ib-bn')!.textContent;

describe.if(hasDom)('the marks in the list', () => {
  test('the question mark: unfilled when open, the amber tint pill holding up work, the red tint pill stopped', () => {
    for (const scope of ['.ib-row', '.ib-nrow', '.ib-mrow']) {
      const el = mount({ sections: STEPS, narrow: scope === '.ib-nrow', phone: scope === '.ib-mrow' });
      const open = qmark(el, 'msg_wait', scope)!;
      expect(open.dataset.waitStep).toBe('open');
      expect(open.className).toBe('ib-c ib-qn');
      expect(face(open)).toBe('2');
      expect(said(open)).toBe('2 questions');
      const hold = qmark(el, 'msg_hold', scope)!;
      expect(hold.dataset.waitStep).toBe('hold');
      expect(hold.classList.contains('ib-badge')).toBe(true);
      expect(hold.classList.contains('ib-b-hold')).toBe(true);
      expect(face(hold)).toBe('1');
      expect(said(hold)).toBe('Holding up work: 1 question');
      const stop = qmark(el, 'msg_stop', scope)!;
      expect(stop.dataset.waitStep).toBe('stop');
      expect(stop.classList.contains('ib-b-stop')).toBe(true);
      expect(said(stop)).toBe('Stopped on you: 2 questions');
      // One mark per row: no triangle badge, no second count.
      expect(el.querySelector('[data-row-badge], svg.ib-tri')).toBeNull();
      for (const id of ['msg_wait', 'msg_hold', 'msg_stop']) expect(el.querySelectorAll(`${scope}[data-thread-id="${id}"] .ib-qn`)).toHaveLength(1);
      act(() => root!.unmount());
      host!.remove();
      root = null;
    }
  });

  test('the action box: the same steps, its number the open action items; stopped only by an action item, no question mark', () => {
    for (const scope of ['.ib-row', '.ib-nrow', '.ib-mrow']) {
      const el = mount({ sections: STEPS, narrow: scope === '.ib-nrow', phone: scope === '.ib-mrow' });
      const open = abox(el, 'msg_actopen', scope)!;
      expect(open.dataset.waitStep).toBe('open');
      expect(open.classList.contains('ib-b-act')).toBe(true);
      expect(face(open)).toBe('2');
      expect(said(open)).toBe('2 actions to do');
      const hold = abox(el, 'msg_acthold', scope)!;
      expect(hold.dataset.waitStep).toBe('hold');
      expect(hold.classList.contains('ib-b-hold')).toBe(true);
      expect(hold.classList.contains('ib-b-act')).toBe(false);
      expect(said(hold)).toBe('Holding up work: 2 action items');
      // Its question holds nothing up: it stays open beside the filled box.
      expect(qmark(el, 'msg_acthold', scope)!.dataset.waitStep).toBe('open');
      const stop = abox(el, 'msg_actstop', scope)!;
      expect(stop.dataset.waitStep).toBe('stop');
      expect(stop.classList.contains('ib-b-stop')).toBe(true);
      expect(face(stop)).toBe('1');
      expect(said(stop)).toBe('Stopped on you: 1 action item');
      expect(qmark(el, 'msg_actstop', scope)).toBeNull();
      act(() => root!.unmount());
      host!.remove();
      root = null;
    }
  });

  test('past 99 the face draws 99+, the words keep the exact count', async () => {
    const el = mount({ sections: STEPS });
    const many = qmark(el, 'msg_many')!;
    expect(face(many)).toBe('99+');
    expect(said(many)).toBe('Holding up work: 104 questions');
    const open = qmark(el, 'msg_manyopen')!;
    expect(face(open)).toBe('99+');
    expect(said(open)).toBe('104 questions');
    // An open mark's tooltip is its words.
    await tooltipOf(qmark(el, 'msg_manyopen')!, 0);
    unhover(qmark(el, 'msg_manyopen')!);
    expect(await tooltipOf(qmark(el, 'msg_manyopen')!)).toBe('104 questions');
  });

  test('a blocked row with words in place of its counts keeps its filled mark, and only that one', () => {
    for (const narrow of [false, true]) {
      const el = mount({ sections: STEPS, narrow });
      const scope = narrow ? '.ib-nrow' : '.ib-row';
      const r = el.querySelector<HTMLElement>(`${scope}[data-thread-id="msg_answered"]`)!;
      expect(r.querySelector('[data-count-words]')!.getAttribute('data-count-words')).toBe('Answered, not sent');
      expect(said(qmark(el, 'msg_answered', scope))).toBe('Holding up work: 1 question');
      // The open action box gives way to the words, as the counts did before.
      expect(abox(el, 'msg_answered', scope)).toBeNull();
      act(() => root!.unmount());
      host!.remove();
      root = null;
    }
  });

  test(`a wide row in full-width mode: the words ${WIDE_ROW_WAIT_WORDS ? 'stay' : 'go'} ("Stopped", "Holds up 3", WIDE_ROW_WAIT_WORDS)`, () => {
    const el = mount();
    const stop = el.querySelector<HTMLElement>('.ib-row[data-thread-id="msg_stop"] .ib-bcol [data-wait-words]');
    const hold = el.querySelector<HTMLElement>('.ib-row[data-thread-id="msg_hold"] .ib-bcol [data-wait-words]');
    if (!WIDE_ROW_WAIT_WORDS) {
      expect(stop).toBeNull();
      expect(hold).toBeNull();
      return;
    }
    expect(stop!.textContent).toBe('Stopped');
    expect(hold!.textContent).toBe('Holds up 3');
    // Seen only: the mark's words and the row's description say it to a screen reader.
    expect(stop!.getAttribute('aria-hidden')).toBe('true');
    expect(el.querySelector('.ib-row[data-thread-id="msg_wait"] [data-wait-words]')).toBeNull();
    // Beside a thread and on a phone, no words: the marks alone.
    mountAgain({ narrow: true });
    expect(document.querySelector('[data-wait-words]')).toBeNull();
  });

  test("the row's name stays short; the card's words are its description", () => {
    const el = mount();
    const r = el.querySelector<HTMLElement>('[data-thread-id="msg_stop"]')!;
    const id = r.getAttribute('aria-describedby')!;
    expect(id).toBeTruthy();
    const words = document.getElementById(id)!;
    expect(words.hidden).toBe(true);
    expect(words.textContent).toBe(badgeDescription(STOP));
    // The words sit beside the row, not in it: its name reads as before.
    expect(r.contains(words)).toBe(false);
    expect(r.textContent).not.toContain('cannot ship');
    expect(el.querySelector('[data-thread-id="msg_wait"]')!.hasAttribute('aria-describedby')).toBe(false);
  });

  test('card A on hover of a filled mark: the header (the bubble, no triangle), one row per item, the footer', async () => {
    const el = mount();
    const text = await tooltipOf(qmark(el, 'msg_stop')!);
    expect(text).not.toBeNull();
    const c = card()!;
    expect(c.dataset.waitCard).toBe('stop');
    expect(c.querySelector<HTMLElement>('.ib-wc-tri')!.dataset.waitCardGlyph).toBe('question');
    expect(c.querySelector('.ib-wc-tri svg.ib-qbub')).not.toBeNull();
    expect(c.querySelector('svg.ib-tri')).toBeNull();
    expect(c.querySelector('.ib-wc-h')!.textContent).toBe('Stopped');
    expect(c.querySelector('.ib-wc-chip')!.textContent).toBe('retry-worker');
    expect([...c.querySelectorAll('.ib-wc-row')].map((r) => r.textContent)).toEqual(['Q1The retry worker cannot ship without this', 'Q2The retry worker', 'Q2The admin retry view']);
    expect(c.querySelector('.ib-wc-sub')!.textContent).toBe('Also holds up 2');
    expect(c.querySelector('.ib-wc-foot')!.textContent).toContain('Claude Code');
    unhover(qmark(el, 'msg_stop')!);
    await settle();
    expect(card() === null).toBe(true);

    // The held-up count lives in the card now.
    await tooltipOf(qmark(el, 'msg_hold')!);
    expect(card()!.querySelector('.ib-wc-h')!.textContent).toBe('Holds up 3');
    expect(card()!.querySelector('.ib-wc-q')).toBeNull();
    expect(card()!.querySelector('.ib-wc-foot')!.textContent).toContain('OpenCode');
  });

  test("an action item's stop: the card opens on the action box, its header the box", async () => {
    const el = mount({ sections: STEPS });
    await tooltipOf(abox(el, 'msg_actstop')!);
    const c = card()!;
    expect(c.dataset.waitCard).toBe('stop');
    expect(c.querySelector<HTMLElement>('.ib-wc-tri')!.dataset.waitCardGlyph).toBe('action');
    expect([...c.querySelectorAll('.ib-wc-row')].map((r) => r.textContent)).toEqual(['The key rotation cannot run without a session']);
  });

  test('keyboard focus on the row opens the card; leaving the row closes it', async () => {
    for (const narrow of [false, true]) {
      const el = mount({ narrow });
      const r = el.querySelector<HTMLElement>(`${narrow ? '.ib-nrow' : '.ib-row'}[data-thread-id="msg_hold"]`)!;
      act(() => r.focus());
      await settle(50);
      expect(card()!.dataset.waitCard).toBe('hold');
      // One card, not one per trigger (the wide row's words and its mark).
      expect([...document.querySelectorAll('[data-wait-card]')].filter((c) => !c.closest('[data-pn-tooltip]')?.hasAttribute('data-closed'))).toHaveLength(1);
      // Inside the window's root, where the Soft tokens reach it.
      expect(el.contains(card())).toBe(true);
      act(() => r.blur());
      await settle();
      expect(card() === null).toBe(true);
      // A row with nothing blocked opens nothing.
      act(() => el.querySelector<HTMLElement>('[data-thread-id="msg_wait"]')!.focus());
      await settle(50);
      expect(card() === null).toBe(true);
      act(() => root!.unmount());
      host!.remove();
      root = null;
    }
  });

  test('Escape closes the card and keeps focus on the row, without reaching the window; the next Escape does', async () => {
    const el = mount();
    const r = el.querySelector<HTMLElement>('[data-thread-id="msg_stop"]')!;
    act(() => r.focus());
    await settle(50);
    expect(card()!.dataset.waitCard).toBe('stop');
    const seen: boolean[] = [];
    const onWindow = (e: KeyboardEvent) => seen.push(e.defaultPrevented);
    window.addEventListener('keydown', onWindow);
    try {
      act(() => {
        r.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      });
      await settle();
      expect(card() === null).toBe(true);
      expect(document.activeElement).toBe(r);
      // The window's Escape (closing a thread) skips an Escape that is already used.
      expect(seen).toEqual([true]);
      // With the card closed, Escape is the window's again.
      act(() => {
        r.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      });
      expect(seen).toEqual([true, false]);
    } finally {
      window.removeEventListener('keydown', onWindow);
    }
    // The card comes back with the next keyboard focus.
    act(() => r.blur());
    act(() => r.focus());
    await settle(50);
    expect(card()!.dataset.waitCard).toBe('stop');
  });

  test('beside a thread: line 3 ends with the marks, the agents are on line 1', () => {
    const el = mount({ narrow: true });
    const parts = (id: string) =>
      [...el.querySelector(`.ib-nrow[data-thread-id="${id}"] .ib-l3`)!.children].map((c) =>
        c.classList.contains('ib-qn') ? `?${face(c as HTMLElement)}:${(c as HTMLElement).dataset.waitStep}` : c.className.split(' ')[0],
      );
    // The preview first (a named thread's subject), then the mark last.
    expect(parts('msg_stop')).toEqual(['ib-pv', '?2:stop']);
    expect(parts('msg_hold')).toEqual(['ib-pv', '?1:hold']);
    // An unnamed thread's subject is its title: no preview, the mark alone; nothing to count: no line 3 at all.
    expect(parts('msg_wait')).toEqual(['?2:open']);
    expect(parts('msg_news')).toEqual([]);
    for (const id of ['msg_stop', 'msg_hold', 'msg_wait', 'msg_pair', 'msg_news']) {
      const l = el.querySelector(`.ib-nrow[data-thread-id="${id}"]`)!;
      expect(l.querySelector('.ib-l3 .ib-mk')).toBeNull();
      expect(l.querySelector('.ib-l1 .ib-from > .ib-atiles .ib-mk')).not.toBeNull();
    }
  });

  test('a phone: the marks alone, no card; they end line 3, after the preview', async () => {
    const el = mount({ phone: true });
    const r = el.querySelector<HTMLElement>('.ib-mrow[data-thread-id="msg_hold"]')!;
    const stop = el.querySelector<HTMLElement>('.ib-mrow[data-thread-id="msg_stop"]')!;
    expect([...stop.querySelector('.ib-m3')!.children].map((c) => (c as HTMLElement).dataset.waitStep ?? c.className.split(' ')[0])).toEqual(['ib-pv', 'stop']);
    expect(stop.querySelector('.ib-m3 .ib-mk')).toBeNull();
    act(() => r.focus());
    await tooltipOf(qmark(el, 'msg_hold', '.ib-mrow')!);
    expect(card() === null).toBe(true);
    expect(document.getElementById(r.getAttribute('aria-describedby')!)!.textContent).toBe(badgeDescription(HOLD));
  });
});

/** Mount again in place of the list on screen. */
function mountAgain(opts: { narrow?: boolean; phone?: boolean; sections?: InboxListSection[] }) {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  return mount(opts);
}
