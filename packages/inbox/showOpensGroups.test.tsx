import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxListGroupId, InboxListRow, InboxListSection, InboxSectionId } from '@plannotator/core/inbox-types';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');
const { LIST_GROUPS_COOKIE } = await import('./listGroups');
const { writeListView } = await import('./listView');
const { showLandsIn } = await import('./held');
const { setStorageBackend, resetStorageBackend } = await import('@plannotator/ui/utils/storage');

let root: Root | null = null;
let host: HTMLElement | null = null;
const stored = new Map<string, string>();
beforeEach(() => {
  stored.clear();
  setStorageBackend({
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => void stored.set(key, value),
    removeItem: (key) => void stored.delete(key),
  });
});
afterEach(() => {
  if (!hasDom) return;
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = '';
  writeListView('grouped');
  resetStorageBackend();
});

const LONG_AGO = '2026-10-10T10:00:00.000Z';
const NOW = '2026-11-08T10:00:00.000Z';
function row(id: string, section: InboxSectionId, at = LONG_AGO): InboxListRow {
  return {
    thread_id: id,
    project_id: 'prj_1',
    subject: `Thread ${id}`,
    author: { kind: 'agent', host: 'claude-code', session: `ses_${id}`, name: null },
    created_at: at,
    last_at: at,
    last_agent_at: at,
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: section === 'quiet' ? 0 : 1, picked: 0, stopped: false, holds_up: section === 'holding' ? ['x'] : [], prompt: null, actions: 0 },
    waiting_on_person: section !== 'quiet',
    project: { id: 'prj_1', name: 'alpha' },
    thread_name: null,
    section,
    unread: section !== 'quiet',
    answered_not_sent: false,
    waiting_since: null,
    unseen: 0,
    sent: null,
    guide: false,
  } as InboxListRow;
}

const LABELS: Partial<Record<InboxListGroupId, string>> = { holding: 'Holding up work', waiting: 'Waiting on you', quiet: 'Quiet' };
const section = (id: InboxListGroupId, threads: InboxListRow[]): InboxListSection => ({ id, label: LABELS[id]!, threads });

const SHOWN = [section('holding', [row('t_hold', 'holding')]), section('waiting', [row('t_wait', 'waiting')]), section('quiet', [row('t_quiet', 'quiet')])];
const LATEST = [section('holding', [row('t_hold', 'holding')]), section('waiting', [row('t_new', 'waiting', NOW), row('t_wait', 'waiting')]), section('quiet', [row('t_quiet', 'quiet')])];

function HeldList() {
  const [shown, setShown] = useState(SHOWN);
  const held = shown !== LATEST;
  return (
    <SidebarProvider>
      <div className="pn-inbox">
        <InboxList
          title="Inbox"
          path={null}
          sections={shown}
          filtered={false}
          narrow={false}
          selectedThreadId={null}
          notice={held ? { count: 1, lands: showLandsIn(shown, LATEST) } : null}
          onShowNew={() => setShown(LATEST)}
          onOpen={() => {}}
        />
      </div>
    </SidebarProvider>
  );
}

function draw(): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<HeldList />));
}

const group = (id: InboxListGroupId) => host!.querySelector<HTMLElement>(`[data-section-id="${id}"]`);
const isOpen = (id: InboxListGroupId) => group(id)!.querySelector(':scope > .ib-band')!.getAttribute('aria-expanded') === 'true';
const drawn = (threadId: string) => host!.querySelector(`[data-thread-id="${threadId}"]`) !== null;
const show = () => act(() => host!.querySelector<HTMLButtonElement>('[data-inbox-notice]')!.click());

test.skipIf(!hasDom)('Show opens a closed group its new row lands in, and the row is on screen', () => {
  stored.set(LIST_GROUPS_COOKIE, 'waiting:1762400000000');
  draw();
  expect(isOpen('waiting')).toBe(false);
  expect(isOpen('quiet')).toBe(false);
  expect(isOpen('holding')).toBe(true);
  expect(drawn('t_new')).toBe(false);

  show();
  expect(host!.querySelector('[data-inbox-notice]')).toBeNull();
  expect(isOpen('waiting')).toBe(true);
  expect(drawn('t_new')).toBe(true);
  expect(isOpen('quiet')).toBe(false);
  expect(isOpen('holding')).toBe(true);

  expect(stored.get(LIST_GROUPS_COOKIE) ?? '').not.toContain('waiting');
  act(() => root?.unmount());
  host?.remove();
  draw();
  expect(isOpen('waiting')).toBe(true);
  expect(isOpen('quiet')).toBe(false);
});

test.skipIf(!hasDom)('the List view opens no group on Show and draws the new row', () => {
  stored.set(LIST_GROUPS_COOKIE, 'waiting:1762400000000');
  writeListView('list');
  draw();
  expect(group('waiting')).toBeNull();
  show();
  expect(drawn('t_new')).toBe(true);
  expect(stored.get(LIST_GROUPS_COOKIE)).toBe('waiting:1762400000000');
});
