/**
 * The list rows' Stopped and Holds up badges and their hover card (approval
 * "inbox-row-badges", 2026-10-25):
 *
 *  - Stopped is a triangle alone, Holds up a triangle and its count; the
 *    words stay for a screen reader ("Stopped", "Holds up 3"), visually hidden.
 *  - Card A opens on the badge after the tooltip delay and while the row has
 *    keyboard focus: a header, one row per item, Q labels only when the items
 *    come from more than one question, a footer with the agent and the time.
 *  - The row's name stays short; the card's words ride aria-describedby.
 *  - The agent's mark has its own column before the time (wide). On a
 *    two-line row and a phone row (approval "inbox-row-byline", 2026-10-29)
 *    line 1 is the project, the thread's pill and the time; line 2 is the
 *    subject, then the marks, the badge and the open count `?N` last.
 *  - A phone draws the icons only: no card.
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
import { badgeDescription, waitCardModel } from './components/RowBadge';

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

function mount(opts: { narrow?: boolean; phone?: boolean } = {}): HTMLElement {
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
          sections={SECTIONS}
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

describe.if(hasDom)('the badges in the list', () => {
  test('a wide row: the triangle and its words, "Stopped" and "Holds up 3", drawn (the owner, 2026-10-29)', () => {
    const el = mount();
    const stop = el.querySelector<HTMLElement>('.ib-row[data-thread-id="msg_stop"] [data-row-badge]')!;
    expect(stop.querySelector('svg.ib-tri')).not.toBeNull();
    expect(stop.classList.contains('ib-bwords')).toBe(true);
    expect(stop.textContent).toBe('Stopped');
    expect(stop.querySelector('.ib-sr')).toBeNull();
    expect(stop.querySelector('.ib-bw')!.textContent).toBe('Stopped');
    const hold = el.querySelector<HTMLElement>('.ib-row[data-thread-id="msg_hold"] [data-row-badge]')!;
    expect(hold.textContent).toBe('Holds up 3');
    expect(hold.querySelector('.ib-sr')).toBeNull();
    expect(hold.querySelector('.ib-bw')!.textContent).toBe('Holds up 3');
  });

  test('a two-line row: a triangle alone and a triangle with its count; the words stay for a screen reader', () => {
    const el = mount({ narrow: true });
    const stop = el.querySelector<HTMLElement>('[data-thread-id="msg_stop"] [data-row-badge]')!;
    expect(stop.classList.contains('ib-bwords')).toBe(false);
    expect(stop.dataset.rowBadge).toBe('stopped');
    expect(stop.classList.contains('ib-b-stop')).toBe(true);
    expect(stop.querySelector('svg.ib-tri')).not.toBeNull();
    expect(stop.textContent).toBe('Stopped');
    expect(stop.querySelector('.ib-sr')!.textContent).toBe('Stopped');
    const hold = el.querySelector<HTMLElement>('[data-thread-id="msg_hold"] [data-row-badge]')!;
    expect(hold.classList.contains('ib-b-hold')).toBe(true);
    expect(hold.textContent).toBe('Holds up 3');
    expect(hold.querySelector('.ib-bn')!.textContent).toBe('3');
    // The only text drawn is the count: "Holds up " is visually hidden.
    expect(hold.querySelector('.ib-sr')!.textContent).toBe('Holds up ');
    expect(el.querySelector('[data-thread-id="msg_wait"] [data-row-badge]')).toBeNull();
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

  test('card A on hover: the header, one row per item, the footer', async () => {
    const el = mount();
    const text = await tooltipOf(el.querySelector('[data-thread-id="msg_stop"] [data-row-badge]')!);
    expect(text).not.toBeNull();
    const c = card()!;
    expect(c.dataset.waitCard).toBe('stop');
    expect(c.querySelector('.ib-wc-h')!.textContent).toBe('Stopped');
    expect(c.querySelector('.ib-wc-chip')!.textContent).toBe('retry-worker');
    expect([...c.querySelectorAll('.ib-wc-row')].map((r) => r.textContent)).toEqual(['Q1The retry worker cannot ship without this', 'Q2The retry worker', 'Q2The admin retry view']);
    expect(c.querySelector('.ib-wc-sub')!.textContent).toBe('Also holds up 2');
    expect(c.querySelector('.ib-wc-foot')!.textContent).toContain('Claude Code');
    unhover(el.querySelector('[data-thread-id="msg_stop"] [data-row-badge]')!);
    await settle();
    expect(card() === null).toBe(true);

    await tooltipOf(el.querySelector('[data-thread-id="msg_hold"] [data-row-badge]')!);
    expect(card()!.querySelector('.ib-wc-h')!.textContent).toBe('Holds up 3');
    expect(card()!.querySelector('.ib-wc-q')).toBeNull();
    expect(card()!.querySelector('.ib-wc-foot')!.textContent).toContain('OpenCode');
  });

  test('keyboard focus on the row opens the card; leaving the row closes it', async () => {
    const el = mount();
    const r = el.querySelector<HTMLElement>('[data-thread-id="msg_hold"]')!;
    act(() => r.focus());
    await settle(50);
    expect(card()!.dataset.waitCard).toBe('hold');
    // Inside the window's root, where the Soft tokens reach it.
    expect(el.contains(card())).toBe(true);
    act(() => r.blur());
    await settle();
    expect(card() === null).toBe(true);
    // A row with no badge opens nothing.
    act(() => el.querySelector<HTMLElement>('[data-thread-id="msg_wait"]')!.focus());
    await settle(50);
    expect(card() === null).toBe(true);
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

  test('beside a thread too: the card on keyboard focus; line 1 is the project, the pill and the time; line 2 ends with the marks, the badge and ?N', async () => {
    const el = mount({ narrow: true });
    const r = el.querySelector<HTMLElement>('.ib-nrow[data-thread-id="msg_stop"]')!;
    const parts = (id: string, line: 'ib-l1' | 'ib-l2') =>
      [...el.querySelector(`.ib-nrow[data-thread-id="${id}"] .${line}`)!.children].map((c) =>
        c.matches('[data-row-badge]') ? 'badge' : c.classList.contains('ib-qn') ? `?${c.querySelector('[aria-hidden="true"]:not(svg)')!.textContent}` : c.className.split(' ')[0],
      );
    // Line 1 (approval "inbox-row-byline"): the project, the thread's pill, the time; no count and no mark.
    expect(parts('msg_stop', 'ib-l1')).toEqual(['ib-pw', 'ib-key', 'ib-t']);
    expect(r.querySelector('.ib-l1 :is(.ib-mk, .ib-c)')).toBeNull();
    // Line 2: the subject first, then the marks, the badge and the open count last.
    expect(parts('msg_stop', 'ib-l2')).toEqual(['ib-s', 'ib-mcol', 'badge', '?2']);
    expect(r.querySelector('.ib-l2 > .ib-mcol .ib-mk')).not.toBeNull();
    // One question counts too; its words are for a screen reader.
    expect(parts('msg_hold', 'ib-l2')).toEqual(['ib-s', 'ib-mcol', 'badge', '?1']);
    expect(el.querySelector('.ib-nrow[data-thread-id="msg_hold"] .ib-qn .ib-sr')!.textContent).toBe('1 question');
    // No badge: the marks sit right before the count; nothing to count: the marks end the line.
    expect(parts('msg_wait', 'ib-l2')).toEqual(['ib-s', 'ib-mcol', '?2']);
    expect(parts('msg_news', 'ib-l2')).toEqual(['ib-s', 'ib-mcol']);
    expect(parts('msg_news', 'ib-l1')).toEqual(['ib-pw', 'ib-t']);
    // Two agents: both marks, at the scale's tile size, in the same box, where a single mark would be.
    expect(parts('msg_pair', 'ib-l2')).toEqual(['ib-s', 'ib-mcol', '?2']);
    const pair = el.querySelector('.ib-nrow[data-thread-id="msg_pair"] .ib-l2 > .ib-mcol')!;
    expect(pair.querySelectorAll('.ib-tg-stack > .ib-mk').length).toBe(2);
    act(() => r.focus());
    await settle(50);
    expect(card()!.dataset.waitCard).toBe('stop');
  });

  test('a phone: icons only, no card; the marks, the badge and the count end line 2, after the subject', async () => {
    const el = mount({ phone: true });
    const r = el.querySelector<HTMLElement>('.ib-mrow[data-thread-id="msg_hold"]')!;
    expect(r.querySelector('[data-row-badge]')!.textContent).toBe('Holds up 3');
    expect([...r.querySelector('.ib-m1')!.children].map((c) => c.className)).toEqual(['ib-pw', 'ib-key', 'ib-t']);
    const stop = el.querySelector<HTMLElement>('.ib-mrow[data-thread-id="msg_stop"]')!;
    expect([...stop.querySelector('.ib-ml2')!.children].map((c) => c.className.split(' ').slice(0, 2).join('.'))).toEqual(['ib-m2', 'ib-mcol', 'ib-badge.ib-bicon', 'ib-c.ib-qn']);
    // Nothing else to list: two lines all the same, the marks ending line 2.
    const news = el.querySelector<HTMLElement>('.ib-mrow[data-thread-id="msg_news"]')!;
    expect([...news.children].filter((c) => !c.classList.contains('ib-sr')).map((c) => c.className)).toEqual(['ib-m1', 'ib-ml2']);
    expect([...news.querySelector('.ib-ml2')!.children].map((c) => c.className)).toEqual(['ib-m2', 'ib-mcol']);
    act(() => r.focus());
    await tooltipOf(r.querySelector('[data-row-badge]')!);
    expect(card() === null).toBe(true);
    expect(document.getElementById(r.getAttribute('aria-describedby')!)!.textContent).toBe(badgeDescription(HOLD));
  });
});
