import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxListSection } from '@plannotator/core/inbox-types';
import { inboxListSections } from '../shared/inbox/list';
import { InboxStore } from '../shared/inbox/store';
import { markHeldRowLooked } from './held';

const hasDom = typeof document !== 'undefined';
const { InboxList } = (hasDom ? await import('./components/InboxList') : {}) as typeof import('./components/InboxList');
const { SidebarProvider } = (hasDom ? await import('./shell/sidebar') : {}) as typeof import('./shell/sidebar');

const AGENT: Extract<InboxAuthor, { kind: 'agent' }> = { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null };
const question = (prompt: string, line: string | null) =>
  ['One call before I go on.', '', ':::question', prompt, ...(line ? [line] : []), '', '- [ ] Yes', '- [ ] No', ':::'].join('\n');

const dirs: string[] = [];
let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (hasDom) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seed() {
  const dir = mkdtempSync(join(tmpdir(), 'plannotator-inbox-read-waiting-'));
  dirs.push(dir);
  const store = InboxStore.open(dir);
  const project = store.ensureProject({ name: 'billing', root: '/work/billing' });
  const send = (session: string, body: string, reply_to?: string) =>
    store.sendMessage({ project_id: project.id, author: { ...AGENT, session }, body, ...(reply_to ? { reply_to } : {}) }).message;
  const stopped = send('ses_s', question('Which retry rule?', 'Stopped: the worker cannot ship without this.'));
  const holding = send('ses_h', question('Detect the agents?', 'Holds up: the install page; the agent table; the screenshots.'));
  const waiting = send('ses_w', question('Trust the webhook?', null));
  return { store, send, ids: { stopped: stopped.id, holding: holding.id, waiting: waiting.id } };
}

function draw(sections: InboxListSection[]): HTMLElement {
  if (!host) {
    host = document.createElement('div');
    host.className = 'pn-inbox';
    document.body.append(host);
    root = createRoot(host);
  }
  act(() =>
    root!.render(
      <SidebarProvider>
        <InboxList title="Inbox" path={null} sections={sections} filtered={false} narrow={false} selectedThreadId={null} notice={null} onShowNew={() => {}} onOpen={() => {}} onMarkRead={() => {}} onMarkUnread={() => {}} />
      </SidebarProvider>,
    ),
  );
  return host;
}

function look(el: HTMLElement, id: string) {
  const row = el.querySelector<HTMLElement>(`.ib-row[data-thread-id="${id}"]`);
  if (!row) return null;
  return {
    bold: row.classList.contains('ib-u'),
    group: row.dataset.section,
    mark: row.querySelector<HTMLElement>('[data-wait-step]')?.dataset.waitStep ?? null,
    open: row.querySelector<HTMLElement>('[data-open-count]')?.dataset.openCount ?? null,
  };
}

describe.if(hasDom)('a thread you have read', () => {
  test('stops being bold on open and after the look lands, in its group with its chips; a new agent message makes it bold again', () => {
    const { store, send, ids } = seed();
    const shown = inboxListSections(store.listRows());
    let el = draw(shown);
    expect(look(el, ids.stopped)).toEqual({ bold: true, group: 'stopped', mark: 'stop', open: '1' });
    expect(look(el, ids.holding)).toEqual({ bold: true, group: 'holding', mark: 'hold', open: '1' });
    expect(look(el, ids.waiting)).toEqual({ bold: true, group: 'waiting', mark: 'open', open: '1' });

    el = draw(markHeldRowLooked(shown, new Set([ids.waiting])));
    expect(look(el, ids.waiting)).toEqual({ bold: false, group: 'waiting', mark: 'open', open: '1' });
    expect(look(el, ids.holding)!.bold).toBe(true);

    for (const id of Object.values(ids)) store.markSeen(id);
    el = draw(inboxListSections(store.listRows()));
    expect(look(el, ids.stopped)).toEqual({ bold: false, group: 'stopped', mark: 'stop', open: '1' });
    expect(look(el, ids.holding)).toEqual({ bold: false, group: 'holding', mark: 'hold', open: '1' });
    expect(look(el, ids.waiting)).toEqual({ bold: false, group: 'waiting', mark: 'open', open: '1' });
    expect(el.querySelector(`[data-row="${ids.waiting}"] [data-row-mark-read]`)).not.toBeNull();
    expect(el.querySelector(`[data-row="${ids.waiting}"] [data-row-mark-unread]`)).toBeNull();

    send('ses_w', 'One more note: the webhook retries for 3 days.', ids.waiting);
    el = draw(inboxListSections(store.listRows()));
    expect(look(el, ids.waiting)).toEqual({ bold: true, group: 'waiting', mark: 'open', open: '1' });
    expect(look(el, ids.holding)!.bold).toBe(false);
    expect(look(el, ids.stopped)!.bold).toBe(false);
  });
});
