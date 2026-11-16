/**
 * The one-time Priority dialog in a DOM (reveals.ts `priority`): the dialog (components/PriorityIntro.tsx), its
 * moment's page-side need (priorityIntro.ts) and Try it against the real menus (the header ⋯ menu, the ⋯ sheet and the
 * row's right-click menu).
 *
 * What regresses: its words; the picture taking focus or clicks; the first focus leaving Try it; Escape or a click
 * outside settling it instead of being the line's Not now, or Got it being one; the page claiming it on the List view,
 * with too few threads waiting, or once the person added a thread to Priority; Try it adding anything, opening no
 * menu, or leaving focus off Add to Priority.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxThread } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { PriorityIntro, PRIORITY_INTRO_COPY } = (hasDom ? await import('./components/PriorityIntro') : {}) as typeof import('./components/PriorityIntro');
const intro = (hasDom ? await import('./priorityIntro') : {}) as typeof import('./priorityIntro');
const { ThreadMore } = (hasDom ? await import('./components/CopyMenus') : {}) as typeof import('./components/CopyMenus');
const { ThreadRowMenu } = (hasDom ? await import('./components/RowMenu') : {}) as typeof import('./components/RowMenu');

const DAY = 24 * 60 * 60 * 1000;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
});

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
const dialog = () => document.querySelector<HTMLDialogElement>('dialog[data-dialog="priority-intro"]');

function row(id: string, over: Partial<InboxListRow> = {}): InboxListRow {
  const old = new Date(Date.now() - 2 * DAY).toISOString();
  return {
    thread_id: id,
    project_id: 'prj_1',
    subject: `Subject ${id}`,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null },
    created_at: old,
    last_at: old,
    last_agent_at: old,
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 1, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: true,
    project: { id: 'prj_1', name: 'billing' },
    thread_name: `name-${id}`,
    section: 'waiting',
    unread: false,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    unsent: null,
    sent: null,
    guide: false,
    priority: null,
    ...over,
  };
}

const ROWS = [row('msg_a'), row('msg_b'), row('msg_c'), row('msg_d', { section: 'sent', waiting_on_person: false })];

function frame(children: ReactNode) {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(children);
  });
  return host;
}

function mountDialog(phone: boolean) {
  const calls: string[] = [];
  const picture = intro.priorityIntroPicture(ROWS, 'msg_b')!;
  frame(<PriorityIntro picture={picture} phone={phone} onGotIt={() => calls.push('got it')} onTry={() => calls.push('try')} onDismiss={() => calls.push('not now')} />);
  return calls;
}

describe.skipIf(!hasDom)('the dialog', () => {
  for (const phone of [false, true]) {
    test(`${phone ? 'a phone' : 'a computer'}: the words, an inert picture of the thread landing in Priority, first focus on Try it`, () => {
      mountDialog(phone);
      const d = dialog()!;
      expect(d).not.toBeNull();
      expect(d.querySelector('#ib-pqi-title')!.textContent).toBe(PRIORITY_INTRO_COPY.title);
      expect(d.querySelector('#ib-pqi-desc')!.textContent).toBe(PRIORITY_INTRO_COPY.body);
      const how = d.querySelector('.ib-zx-hint')!.textContent!;
      expect(how).toContain(phone ? PRIORITY_INTRO_COPY.howPhone : PRIORITY_INTRO_COPY.howComputer);
      expect(how).toContain(PRIORITY_INTRO_COPY.item);
      const art = d.querySelector<HTMLElement>('[data-priority-intro-picture]')!;
      expect(art.hasAttribute('inert')).toBe(true);
      expect(art.getAttribute('aria-hidden')).toBe('true');
      // The menu item lit, and the aimed thread first, under the Priority band.
      expect(art.querySelector('[data-priority-intro-item]')!.textContent).toContain(PRIORITY_INTRO_COPY.item);
      const groups = [...art.querySelectorAll<HTMLElement>('.ib-group')];
      expect(groups[0]!.dataset.sectionId).toBe('priority');
      expect(groups[0]!.textContent).toContain('Subject msg_b');
      expect(document.activeElement).toBe(d.querySelector('[data-priority-intro-try]'));
      expect([...d.querySelectorAll('.ib-lo-acts button')].map((b) => b.textContent)).toEqual([PRIORITY_INTRO_COPY.gotIt, PRIORITY_INTRO_COPY.tryIt]);
    });
  }

  const PATHS: [string, (d: HTMLDialogElement) => void, string][] = [
    ['Got it settles it', (d) => d.querySelector<HTMLButtonElement>('[data-priority-intro-close]')!.click(), 'got it'],
    ['Try it settles it', (d) => d.querySelector<HTMLButtonElement>('[data-priority-intro-try]')!.click(), 'try'],
    ['Escape is the line’s Not now', (d) => d.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })), 'not now'],
    ['a click outside (the backdrop) is the line’s Not now', (d) => d.dispatchEvent(new MouseEvent('click', { bubbles: true })), 'not now'],
  ];
  for (const [name, close, call] of PATHS) {
    test(name, () => {
      const calls = mountDialog(false);
      act(() => close(dialog()!));
      expect(calls).toEqual([call]);
    });
  }
});

describe.skipIf(!hasDom)('its moment, the page’s side', () => {
  const gate = { listLoaded: true, firstRun: false, grouped: true, rows: ROWS };
  const later = 10 * 60_000;

  test('three threads waiting, nothing in Priority, the grouped list: may claim', () => {
    expect(intro.priorityIntroMayClaim(gate, later)).toBe(true);
  });

  const BLOCKERS: [string, Partial<typeof gate>, number?][] = [
    ['the List view (no Priority group to point at)', { grouped: false }],
    ['two threads waiting', { rows: [ROWS[0]!, ROWS[1]!, ROWS[3]!] }],
    ['a snoozed or archived one does not count', { rows: [ROWS[0]!, ROWS[1]!, row('msg_s', { snoozed: { until: new Date(Date.now() + DAY).toISOString() } as never }), row('msg_r', { resolved_at: new Date().toISOString() })] }],
    ['a thread the person added to Priority', { rows: [...ROWS, row('msg_p', { priority: { person: true, at: new Date().toISOString(), ask: null } })] }],
    ['an Inbox that keeps no priority (rows without the key)', { rows: ROWS.map(({ priority: _p, ...rest }) => rest as InboxListRow) }],
    ['the list not loaded', { listLoaded: false }],
    ['the first run', { firstRun: true }],
    ['a page younger than a minute', {}, 1_000],
  ];
  for (const [name, over, age] of BLOCKERS) {
    test(`not: ${name}`, () => {
      expect(intro.priorityIntroMayClaim({ ...gate, ...over }, age ?? later)).toBe(false);
    });
  }

  test('an agent’s Priority ask does not count as the person’s use', () => {
    expect(intro.priorityIntroHolds([...ROWS, row('msg_q', { priority: { person: false, at: new Date().toISOString(), ask: null } as never })])).toBe(true);
  });

  test('Try it aims at the thread last opened, else the first one waiting; the picture draws it in Priority above the next one waiting', () => {
    expect(intro.priorityIntroTarget(ROWS, 'msg_c')).toBe('msg_c');
    expect(intro.priorityIntroTarget(ROWS, 'msg_gone')).toBe('msg_a');
    expect(intro.priorityIntroTarget(ROWS, null)).toBe('msg_a');
    const picture = intro.priorityIntroPicture(ROWS, 'msg_c')!;
    expect(picture.landed.thread_id).toBe('msg_c');
    expect(picture.landed.priority?.person).toBe(true);
    expect(picture.below?.row.thread_id).toBe('msg_a');
    expect(picture.below?.label).toBeTruthy();
  });
});

const THREAD = { thread_id: 'msg_a', subject: 'Which index?', messages: [], project: { id: 'prj_1', name: 'billing' } } as unknown as InboxThread;

describe.skipIf(!hasDom)('Try it opens the real menu on Add to Priority and adds nothing', () => {
  for (const phone of [false, true]) {
    test(`a thread open${phone ? ', a phone' : ''}: its ⋯ ${phone ? 'sheet' : 'menu'}, focus on Add to Priority`, async () => {
      const toggled: string[] = [];
      frame(
        <section className="ib-pane">
          <ThreadMore thread={THREAD} linkOf={() => ''} phone={phone} priority={{ on: false, onToggle: () => toggled.push('toggle') }} />
        </section>,
      );
      let ok = false;
      await act(async () => {
        ok = await intro.openPriorityMenu({ root: host!, phone, openThread: 'msg_a', target: 'msg_a', openTarget: () => {} });
      });
      expect(ok).toBe(true);
      const item = document.querySelector<HTMLElement>('[data-thread-menu] [data-thread-priority-item]')!;
      expect(item.textContent).toContain('Add to Priority');
      expect(document.activeElement).toBe(item);
      await wait(100);
      expect(toggled).toEqual([]);
    });
  }

  test('no thread open: the right-click menu of the thread last opened, focus on Add to Priority', async () => {
    const acted: string[] = [];
    const target = row('msg_a');
    frame(
      <ThreadRowMenu className="ib-lbody" rowOf={(id) => (id === 'msg_a' ? target : null)} canMarkRead={false} onSnooze={() => acted.push('snooze')} onAction={(_r, action) => acted.push(action)} onTarget={() => {}} held={false}>
        <div data-row="msg_a">
          <button type="button" data-thread-id="msg_a">
            Which index?
          </button>
        </div>
      </ThreadRowMenu>,
    );
    let ok = false;
    await act(async () => {
      ok = await intro.openPriorityMenu({ root: host!, phone: false, openThread: null, target: 'msg_a', openTarget: () => {} });
    });
    expect(ok).toBe(true);
    const item = document.querySelector<HTMLElement>('[data-row-menu="msg_a"] [data-row-action="priority-add"]')!;
    expect(document.activeElement).toBe(item);
    await wait(100);
    expect(acted).toEqual([]);
  });

  test('a phone with no thread open: the thread opens again, then its ⋯ sheet', async () => {
    const opened: string[] = [];
    function Page({ open }: { open: boolean }) {
      return <section className="ib-pane">{open && <ThreadMore thread={THREAD} linkOf={() => ''} phone priority={{ on: false, onToggle: () => {} }} />}</section>;
    }
    frame(<Page open={false} />);
    // The window opens the thread itself, outside the menu's own steps: so does this page.
    const ok = await intro.openPriorityMenu({
      root: host!,
      phone: true,
      openThread: null,
      target: 'msg_a',
      openTarget: (id) => {
        opened.push(id);
        act(() => root!.render(<Page open />));
      },
    });
    await wait(50);
    expect(opened).toEqual(['msg_a']);
    expect(ok).toBe(true);
    expect(document.activeElement).toBe(document.querySelector('[data-thread-menu] [data-thread-priority-item]'));
  });

  test('no thread to aim at: nothing opens', async () => {
    frame(<section className="ib-pane" />);
    let ok = true;
    await act(async () => {
      ok = await intro.openPriorityMenu({ root: host!, phone: false, openThread: null, target: null, openTarget: () => {} });
    });
    expect(ok).toBe(false);
  });
});
