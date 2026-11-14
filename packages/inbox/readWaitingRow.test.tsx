/**
 * A thread the person has read stops being bold, and keeps its place (the
 * owner, 2026-11-08: "if they could unbolden after I at least read the latest
 * message that would be fine. Then they just stay where they are, in the
 * Waiting on you or Holding up work list"). Before, a row in Stopped, Holding
 * up work or Waiting on you was bold for as long as its questions were open,
 * however often the person read it.
 *
 * Proved on a real store in a temp dir and the real list: the rows the store
 * gives are drawn by InboxList, opening a row is the window's own step
 * (held.ts `markHeldRowLooked`, before the server's look lands) and then the
 * store's look (`markSeen`). The row stops being bold in its group with its
 * state mark and open count, and an agent's next message makes it bold again.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
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

/** What the person sees of a row: bold or not, the group it is drawn in, and its chips. */
function look(el: HTMLElement, id: string) {
  const row = el.querySelector<HTMLElement>(`.ib-row[data-thread-id="${id}"]`);
  if (!row) return null;
  return {
    bold: row.classList.contains('ib-u'),
    group: row.dataset.section,
    // Its state mark (approval "inbox-question-mark", #2929): the question mark filled for Stopped (`stop`) or
    // Holding up work (`hold`), outlined while it only waits (`open`).
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

    // Opened: the window draws its look at once, before the server has taken it.
    el = draw(markHeldRowLooked(shown, new Set([ids.waiting])));
    expect(look(el, ids.waiting)).toEqual({ bold: false, group: 'waiting', mark: 'open', open: '1' });
    expect(look(el, ids.holding)!.bold).toBe(true);

    // The look lands for all three: the server's list draws them read, each where it was.
    for (const id of Object.values(ids)) store.markSeen(id);
    el = draw(inboxListSections(store.listRows()));
    expect(look(el, ids.stopped)).toEqual({ bold: false, group: 'stopped', mark: 'stop', open: '1' });
    expect(look(el, ids.holding)).toEqual({ bold: false, group: 'holding', mark: 'hold', open: '1' });
    expect(look(el, ids.waiting)).toEqual({ bold: false, group: 'waiting', mark: 'open', open: '1' });
    // Read is not answered: the hover action is still Mark read (set the questions aside), never Mark unread.
    expect(el.querySelector(`[data-row="${ids.waiting}"] [data-row-mark-read]`)).not.toBeNull();
    expect(el.querySelector(`[data-row="${ids.waiting}"] [data-row-mark-unread]`)).toBeNull();

    // The agent writes again in the Waiting thread: bold again, still in Waiting; the others stay read.
    send('ses_w', 'One more note: the webhook retries for 3 days.', ids.waiting);
    el = draw(inboxListSections(store.listRows()));
    expect(look(el, ids.waiting)).toEqual({ bold: true, group: 'waiting', mark: 'open', open: '1' });
    expect(look(el, ids.holding)!.bold).toBe(false);
    expect(look(el, ids.stopped)!.bold).toBe(false);
  });
});
