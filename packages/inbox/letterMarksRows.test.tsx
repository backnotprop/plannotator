import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { settle } from './testing/tooltip';
import type { InboxRowsOption } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { RowMarksScope } = (hasDom ? await import('./letterMarks') : {}) as typeof import('./letterMarks');
const { adoptSavedRows, resetListLookForTests } = await import('./listLook');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

function row(id: string, extra: Partial<InboxListRow> = {}): InboxListRow {
  return {
    thread_id: id,
    project_id: 'prj_billing',
    subject: `Subject ${id}`,
    author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null },
    created_at: '2026-10-10T10:00:00.000Z',
    last_at: '2026-10-10T10:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 1, picked: 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: true,
    project: { id: 'prj_billing', name: 'billing-svc' },
    thread_name: null,
    section: 'waiting',
    unread: false,
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
    ...extra,
  };
}

const HOLD = row('msg_hold', {
  thread_name: 'Fix login redirect',
  section: 'holding',
  questions: { open: 1, picked: 0, stopped: false, holds_up: ['the install page'], prompt: null },
  waits: [{ message_id: 'msg_hold', key: 'q-1', position: 0, prompt: 'Which page?', stopped: null, holds_up: ['the install page'] }],
});
const PLAIN = row('msg_plain', { subject: 'Tests pass on main' });
const SECTIONS: InboxListSection[] = [
  { id: 'holding', label: 'Holding up work', threads: [HOLD] },
  { id: 'waiting', label: 'Waiting on you', threads: [PLAIN] },
];

const realFetch = globalThis.fetch;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  const stored = new Map<string, string>();
  setStorageBackend({ getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => void stored.set(k, v), removeItem: (k) => void stored.delete(k) });
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) =>
    new Response(JSON.stringify({ rows: (JSON.parse(init?.body ?? '{}') as { rows: unknown[] }).rows }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  resetListLookForTests();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetStorageBackend();
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function look(...on: InboxRowsOption[]) {
  act(() => adoptSavedRows(['smallNames', ...on], 1));
}

function mount(shape: 'wide' | 'narrow' | 'phone', tour = false): HTMLElement {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  host.setAttribute('data-pn-tooltip-root', '');
  document.body.append(host);
  root = createRoot(host);
  const list = (
    <InboxList
      title="Inbox"
      path={null}
      sections={SECTIONS}
      filtered={false}
      narrow={shape === 'narrow'}
      selectedThreadId={null}
      notice={null}
      onShowNew={() => {}}
      onOpen={() => {}}
      phone={shape === 'phone'}
      rememberLook={!tour}
    />
  );
  act(() => root!.render(<SidebarProvider>{tour ? <RowMarksScope look={null}>{list}</RowMarksScope> : list}</SidebarProvider>));
  return host;
}

const rowOf = (el: HTMLElement, id: string) => el.querySelector<HTMLElement>(`[data-thread-id="${id}"]`)!;
const marksIn = (el: Element) => el.querySelectorAll('.ib-lm, .ib-lm-dot, .ib-lm-av');
const SHAPES = ['wide', 'narrow', 'phone'] as const;

describe.if(hasDom)('letter marks on the rows', () => {
  test('off by default: no mark on any row shape, the agents lead as before', () => {
    for (const shape of SHAPES) {
      const el = mount(shape);
      expect(marksIn(el).length).toBe(0);
      expect(rowOf(el, 'msg_hold').hasAttribute('data-lm-av')).toBe(false);
      expect(rowOf(el, 'msg_hold').querySelector('.ib-atiles')).not.toBeNull();
      act(() => root!.unmount());
      host!.remove();
    }
  });

  test('Avatar: one solid mark per row, the thread\'s letters with the project\'s on its corner', () => {
    look('marksThreads', 'marksProjects');
    for (const shape of SHAPES) {
      const el = mount(shape);
      const avatar = rowOf(el, 'msg_hold').querySelector('.ib-lm-av')!;
      const [thread, project] = [...avatar.querySelectorAll('.ib-lm')];
      expect(thread!.textContent).toBe('FT');
      expect(thread!.hasAttribute('data-solid')).toBe(true);
      expect(project!.classList.contains('ib-lm-badge')).toBe(true);
      expect(project!.textContent).toBe('BC');
      if (shape !== 'wide') expect(rowOf(el, 'msg_hold').hasAttribute('data-lm-av')).toBe(true);
      expect(rowOf(el, 'msg_hold').querySelectorAll('.ib-lm-tt').length).toBe(0);
      act(() => root!.unmount());
      host!.remove();
    }
  });

  test('Inline: a soft tile before the title and before the project; Dot: the hue alone before the title', () => {
    look('marksThreads', 'marksProjects', 'markInline');
    let el = mount('narrow');
    const title = rowOf(el, 'msg_hold').querySelector('.ib-lm-tt[data-take="inline"] > .ib-lm')!;
    expect(title.textContent).toBe('FT');
    expect(title.hasAttribute('data-solid')).toBe(false);
    expect(rowOf(el, 'msg_hold').querySelector('.ib-lm-rowp')!.textContent).toBe('BC');
    expect(rowOf(el, 'msg_hold').querySelector('.ib-lm-av')).toBeNull();
    act(() => root!.unmount());
    host!.remove();
    look('marksThreads', 'markDot');
    el = mount('wide');
    const dot = rowOf(el, 'msg_hold').querySelector('.ib-lm-tt[data-take="dot"] > .ib-lm-dot')!;
    expect(dot).not.toBeNull();
    expect(rowOf(el, 'msg_hold').querySelector('.ib-lm')).toBeNull();
  });

  test('every mark is hidden from a screen reader; the names stay in text', () => {
    for (const on of [['marksThreads', 'marksProjects'], ['marksThreads', 'marksProjects', 'markInline'], ['marksThreads', 'marksProjects', 'markDot']] as InboxRowsOption[][]) {
      look(...on);
      const el = mount('narrow');
      const marks = [...marksIn(el)];
      expect(marks.length).toBeGreaterThan(0);
      for (const mark of marks) expect(mark.closest('[aria-hidden="true"]')).not.toBeNull();
      expect(rowOf(el, 'msg_hold').textContent).toContain('Fix login redirect');
      expect(rowOf(el, 'msg_hold').textContent).toContain('billing-svc');
      act(() => root!.unmount());
      host!.remove();
    }
  });

  test('Agent icons off in every style: the list hides the agents\' tiles, the marks lead, and the hover card drops the agent\'s mark', async () => {
    for (const style of [[], ['markInline'], ['markDot']] as InboxRowsOption[][]) {
      look('hideAgents', 'marksThreads', 'marksProjects', ...style);
      const el = mount('narrow');
      expect(el.querySelector('.ib-listcol')!.classList.contains('ib-lk-noagents')).toBe(true);
      expect(marksIn(rowOf(el, 'msg_hold')).length).toBeGreaterThan(0);
      act(() => rowOf(el, 'msg_hold').focus());
      await settle(50);
      const foot = document.querySelector('[data-wait-card] .ib-wc-foot')!;
      expect(foot.textContent).toContain('Claude Code');
      expect(foot.firstElementChild!.classList.contains('ib-wc-agent')).toBe(true);
      act(() => rowOf(el, 'msg_hold').blur());
      act(() => root!.unmount());
      host!.remove();
    }
    look('marksThreads');
    const el = mount('narrow');
    act(() => rowOf(el, 'msg_hold').focus());
    await settle(50);
    expect(document.querySelector('[data-wait-card] .ib-wc-foot')!.firstElementChild!.classList.contains('ib-wc-agent')).toBe(false);
  });

  test("the onboarding tour draws no marks, whatever the person's look", () => {
    look('marksThreads', 'marksProjects');
    const el = mount('narrow', true);
    expect(marksIn(el).length).toBe(0);
  });
});
