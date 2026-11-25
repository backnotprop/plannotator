/**
 * A script's post (scriptAuthor.ts): an agent message with no session, no host and no name, as
 * `plannotator inbox call send_message` stores it from a cron job or a plain shell. The window draws a terminal where
 * an agent's icon would be and names it "Script" (the owner, 2026-11-23). The failures these catch:
 *   - a script's row or message head still drawing the neutral `</>` and "An agent";
 *   - an agent with a session but no known host or name (a stdio shim's `ses_` agent) read as a script;
 *   - an agent's shell the CLI names (Gemini CLI: a name, no session) read as a script;
 *   - a routine's row, or an agent's row beside a script's, changing;
 *   - a thread only a script wrote in naming it two ways on one screen (heads "Script", the reply box "An agent");
 *   - a thread a script started and a session took over showing "Script" (or the terminal) on its row, or a label
 *     there naming the script while the reply goes to the session.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. The pure parts run without it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxListRow, InboxListSection, InboxMessageWire, InboxProject, InboxReplyDraftRow, InboxRowDelivery, InboxThread } from '@plannotator/core/inbox-types';
import type { InboxScheduledRow } from '@plannotator/core/inbox-scheduled-types';
import { authorName, isScriptAuthor, messageAuthorName, rowIsScript, rowRecipientName, threadAskerName } from './scriptAuthor';
import { rowScriptOf, scriptTip } from './components/RowAgents';

const hasDom = typeof document !== 'undefined';

const SCRIPT: InboxAuthor = { kind: 'agent', host: null, session: null, name: null };
const SHIM: InboxAuthor = { kind: 'agent', host: null, session: 'ses_shim1', name: null };
const GEMINI: InboxAuthor = { kind: 'agent', host: null, session: null, name: 'Gemini CLI' };
const CLAUDE: InboxAuthor = { kind: 'agent', host: 'claude-code', session: 'ses-api', name: 'Claude Code' };

describe('who is a script', () => {
  test('only an agent with no session, host or name, by its author alone, as its mark is', () => {
    expect(messageAuthorName({ author: SCRIPT })).toBe('Script');
    expect(messageAuthorName({ author: SHIM })).toBe('An agent');
    expect(messageAuthorName({ author: GEMINI })).toBe('Gemini CLI');
    expect(messageAuthorName({ author: CLAUDE })).toBe('Claude Code');
    // One that woke with no session, host or name: the mark (by the author) draws the terminal, so the name agrees.
    expect(messageAuthorName({ author: SCRIPT, wakes: true })).toBe('Script');
    expect(isScriptAuthor(SCRIPT)).toBe(true);
    expect(messageAuthorName({ author: { kind: 'person' } as InboxAuthor })).toBe('An agent');
  });

  test("a row's tiles stand for a script only when no session is in the thread; its tooltip says where it posted", () => {
    expect(rowIsScript({}, SCRIPT)).toBe(true);
    expect(rowIsScript({ participants: [{ host: 'claude-code', session: 'ses-api' }, { host: 'pi', session: 'ses-pi' }] }, SCRIPT)).toBe(false);
    expect(rowIsScript({}, SHIM)).toBe(false);
    expect(scriptTip('Script', rowScriptOf({}, SCRIPT, 'billing-svc'))).toBe('Script in billing-svc');
    expect(scriptTip('Claude Code', rowScriptOf({}, CLAUDE, 'billing-svc'))).toBe('Claude Code');
  });

  test("a thread only a script wrote in is the script's; one a session took over is that session's", () => {
    const person = { author: { kind: 'person' } as InboxAuthor };
    expect(threadAskerName([{ author: SCRIPT }, person, { author: SCRIPT }])).toBe('Script');
    // A session took the script's thread over: the thread's agent is that session, as its row names it.
    expect(threadAskerName([{ author: SCRIPT }, person, { author: CLAUDE }, { author: SCRIPT }])).toBe('Claude Code');
    expect(threadAskerName([{ author: SHIM }])).toBe('An agent');
    expect(threadAskerName([{ author: CLAUDE }])).toBe('Claude Code');
  });

  test("a row names whom a reply goes to: a session that took a script's thread over, the script only where no session takes it, any other row as before", () => {
    const takenOver = { participants: [{ host: 'claude-code', session: 'ses-api', name: 'Claude Code' }] };
    const delivery = (d: Partial<InboxRowDelivery>) => ({ kind: 'reply', state: 'saved', reason: 'reads', send_now: false, message_id: 'm', at: null, host: null, name: null, ...d }) as InboxRowDelivery;
    expect(rowRecipientName(takenOver, SCRIPT)).toBe('Claude Code');
    expect(rowRecipientName({ ...takenOver, delivery: delivery({ host: 'claude-code', name: 'Claude Code' }) }, SCRIPT)).toBe('Claude Code');
    // The person answered the script's own post: that reply is the script's.
    expect(rowRecipientName({ ...takenOver, delivery: delivery({ script: true }) }, SCRIPT)).toBe('Script');
    expect(rowRecipientName({}, SCRIPT)).toBe('Script');
    expect(rowRecipientName({ delivery: delivery({ script: true }) }, SCRIPT)).toBe('Script');
    // An agent's own row: its agent, whatever the delivery says, as before.
    expect(rowRecipientName({ delivery: delivery({ host: 'pi', name: null }) }, CLAUDE)).toBe('Claude Code');
    expect(rowRecipientName({}, SHIM)).toBe('An agent');
  });

  test("the window's toasts and notifications name a script's post Script, and a thread a session took over by that session", async () => {
    const { markReadToast } = await import('./markRead');
    const stopped = { subject: 'Disk at 91%', author: SCRIPT, questions: { open: 1, picked: 0, stopped: true, holds_up: [], prompt: null, actions: 0 } } as Parameters<typeof markReadToast>[0];
    expect(markReadToast(stopped, 'open').detail).toBe('Script was stopped');
    expect(markReadToast({ ...stopped, participants: [{ host: 'claude-code', session: 'ses-api', name: 'Claude Code' }] }, 'open').detail).toBe('Claude Code was stopped');
    expect(authorName(SCRIPT)).toBe('Script');
    expect(authorName(SHIM)).toBe('An agent');
    expect(authorName(CLAUDE)).toBe('Claude Code');
  });
});

// --- Drawn ---------------------------------------------------------------------------------------------------------

const PROJECT: InboxProject = { id: 'prj_1', key: 'billing-svc-abcdef', name: 'billing-svc', root: '/w/billing-svc', created_at: '2026-11-23T07:00:00.000Z' };

function message(id: string, author: InboxAuthor, seq: number, body: string, replyTo: string | null = null): InboxMessageWire {
  return {
    id,
    project_id: PROJECT.id,
    thread_id: 'msg_1',
    reply_to: replyTo,
    author,
    subject: id === 'msg_1' ? 'Spend check' : null,
    body,
    created_at: `2026-11-23T07:${String(seq).padStart(2, '0')}:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
    seq,
  };
}

const thread = (messages: InboxMessageWire[]): InboxThread => ({ thread_id: 'msg_1', project: PROJECT, subject: 'Spend check', thread_name: null, resolved_at: null, messages });

function row(id: string, author: InboxAuthor, subject: string): InboxListRow {
  return {
    thread_id: id,
    project_id: PROJECT.id,
    project: { id: PROJECT.id, name: PROJECT.name },
    subject,
    thread_name: null,
    author,
    created_at: '2026-11-23T07:00:00.000Z',
    last_at: '2026-11-23T07:00:00.000Z',
    last_author: 'agent',
    message_count: 1,
    resolved_at: null,
    questions: { open: 0, picked: 0, stopped: false, holds_up: [], prompt: null, actions: 0 },
    waiting_on_person: false,
    section: 'new',
    unread: true,
    unseen: 0,
    sent: null,
  } as unknown as InboxListRow;
}

/** The Claude Code session that took a script's thread over, as the server lists it (store.ts `listRow`). */
const TOOK_OVER = [{ host: 'claude-code', session: 'ses-api', name: 'Claude Code' }];
const SENT = { at: '2026-11-23T07:03:00.000Z', checked_at: null, wakes: true };
const TO_CLAUDE: InboxRowDelivery = { kind: 'reply', state: 'queued', reason: 'working', send_now: false, message_id: 'msg_3', at: null, host: 'claude-code', name: 'Claude Code' };

/** A row of a thread a script started and that Claude Code session took over. */
function taken(id: string, over: Partial<InboxListRow>): InboxListRow {
  return { ...row(id, SCRIPT, 'Disk at 91% on node 3'), message_count: 3, participants: TOOK_OVER, ...over };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;

beforeEach(async () => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const at = String(input);
    if (at.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (at.includes('/sessions')) return Response.json({ home: null, project: PROJECT, sessions: [] });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(async () => {
  if (!hasDom) return;
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = savedFetch;
  (await import('./scheduled/store')).resetScheduledForTests();
});

async function draw(node: ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<div className="pn-inbox">{node}</div>);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return host;
}

const threadProps = { sent: null, onQuestions: () => {}, onChanged: async () => {}, onClose: () => {}, file: null, onOpenFile: () => {}, onOpenGuide: () => {} };

describe('drawn', () => {
  test.skipIf(!hasDom)("the list: a script's row draws the terminal, named Script; an agent's row and a routine's row beside it do not change", async () => {
    const { InboxList } = await import('./components/InboxList');
    const { SidebarProvider } = await import('./shell/sidebar');
    const { resetScheduledForTests } = await import('./scheduled/store');
    resetScheduledForTests([{ id: 'sch_1', name: 'Nightly deps', thread_id: 'msg_routine', state: 'off', last_run: null, last_change: null } as unknown as InboxScheduledRow]);
    const sections = [
      { id: 'new', label: 'New', threads: [row('msg_agent', CLAUDE, 'Retry webhook on 429'), row('msg_script', SCRIPT, 'Spend check'), row('msg_routine', { ...CLAUDE, session: 'ses-routine' }, 'Run 8'), row('msg_shim', SHIM, 'Drain order')] },
    ] as InboxListSection[];
    const el = await draw(
      <SidebarProvider>
        <InboxList title="Inbox" path={null} sections={sections} filtered={false} narrow={false} selectedThreadId={null} notice={null} onShowNew={() => {}} onOpen={() => {}} pinned={new Set()} />
      </SidebarProvider>,
    );
    const rowEl = (id: string) => el.querySelector(`[data-thread-id="${id}"]`)!;
    const agents = (id: string) => rowEl(id).querySelector('[data-row-agents]');
    expect(agents('msg_script')!.getAttribute('aria-label')).toBe('Script');
    expect(agents('msg_script')!.querySelector('[data-script-mark] svg[data-icon="terminal"]')).not.toBeNull();
    expect(agents('msg_script')!.querySelector('svg[data-icon="code"]')).toBeNull();
    // An agent's row: its own mark and name, no terminal.
    expect(agents('msg_agent')!.getAttribute('aria-label')).toBe('Claude Code');
    expect(rowEl('msg_agent').querySelector('[data-script-mark]')).toBeNull();
    // A session with no known host: the neutral mark and "An agent", as before.
    expect(agents('msg_shim')!.getAttribute('aria-label')).toBe('An agent');
    expect(agents('msg_shim')!.querySelector('svg[data-icon="code"]')).not.toBeNull();
    expect(rowEl('msg_shim').querySelector('[data-script-mark]')).toBeNull();
    // A routine's row: its routine tile, no agents and no terminal.
    expect(rowEl('msg_routine').querySelector('[data-scheduled-tile]')).not.toBeNull();
    expect(agents('msg_routine')).toBeNull();
    expect(rowEl('msg_routine').querySelector('[data-script-mark]')).toBeNull();
  });

  test.skipIf(!hasDom)("a thread a script wrote: the folded and open heads draw the terminal and say Script; the person's reply goes to Script; the reply box names Script too", async () => {
    const { ThreadPane } = await import('./components/Thread');
    const t = thread([
      message('msg_1', SCRIPT, 1, 'Nov 22 · $403 of $450 this month (90%).'),
      message('msg_2', SCRIPT, 2, 'Month to date: **$412** of the $450 budget.', 'msg_1'),
      message('msg_3', { kind: 'person' } as InboxAuthor, 3, 'Thanks.', 'msg_2'),
    ]);
    const el = await draw(<ThreadPane thread={t} {...threadProps} />);
    for (const id of ['msg_1', 'msg_2']) {
      const article = el.querySelector(`[data-message-article="${id}"]`)!;
      expect(article.querySelector('.ib-fl-nm')!.textContent).toBe('Script');
      expect(article.querySelector('[data-fold-head]')!.getAttribute('aria-label')).toStartWith('Script, ');
      expect(article.querySelector('[data-script-mark] svg[data-icon="terminal"]')).not.toBeNull();
      expect(article.querySelector('svg[data-icon="code"]')).toBeNull();
    }
    const reply = el.querySelector('[data-message-article="msg_3"]')!;
    expect(reply.querySelector('.ib-to')!.textContent).toStartWith('to Script');
    expect(el.textContent).toContain('Saved for Script. It sees it when it next reads this thread.');
    // One screen, one name: the reply box names the script too.
    const open = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Reply')!;
    act(() => open.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(el.querySelector('textarea')!.getAttribute('aria-label')).toBe('Reply to Script');
    expect(el.textContent).not.toContain('An agent');
  });

  test.skipIf(!hasDom)("a thread a script started that a Claude Code session took over: the script's head still says Script, the session's says Claude Code, and the reply box goes to Claude Code", async () => {
    const { ThreadPane } = await import('./components/Thread');
    const t = thread([message('msg_1', SCRIPT, 1, 'Disk at 91% on node 3.'), message('msg_2', CLAUDE, 2, 'I can clear the snapshots.', 'msg_1')]);
    const el = await draw(<ThreadPane thread={t} {...threadProps} />);
    const head = (id: string) => el.querySelector(`[data-message-article="${id}"]`)!;
    expect(head('msg_1').querySelector('.ib-fl-nm')!.textContent).toBe('Script');
    expect(head('msg_1').querySelector('[data-script-mark]')).not.toBeNull();
    expect(head('msg_2').querySelector('.ib-fl-nm')!.textContent).toBe('Claude Code');
    expect(head('msg_2').querySelector('[data-script-mark]')).toBeNull();
    const open = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Reply')!;
    act(() => open.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(el.querySelector('textarea')!.getAttribute('aria-label')).toBe('Reply to Claude Code');
  });

  test.skipIf(!hasDom)("a thread only a script wrote in: the reply box's answer groups are Script's messages, never An agent's", async () => {
    const { ThreadPane } = await import('./components/Thread');
    const asked = (id: string, seq: number, prompt: string): InboxMessageWire => ({
      ...message(id, SCRIPT, seq, prompt, id === 'msg_1' ? null : 'msg_1'),
      questions: [
        {
          key: 'q-1', position: 0, kind: 'single', prompt, context: null, choices: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }], recommendation: null, suggested_text: null, stopped: null, holds_up: [],
          asked_by_agent_id: null, orphaned: false, state: 'picked', revision: 1, sent_revision: 0, picked_by: null, picked_at: null, sent_reply_id: null, message_id: id, superseded_by: null,
          answer: { v: 1, key: 'q-1', kind: 'single', prompt, selected: ['yes'] },
        },
      ],
    }) as unknown as InboxMessageWire;
    const el = await draw(<ThreadPane thread={thread([asked('msg_1', 1, 'Clear the snapshots?'), asked('msg_2', 2, 'Page Bob Tully?')])} {...threadProps} />);
    // Picked answers wait in a draft: open it.
    const edit = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Edit draft')!;
    act(() => edit.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const labels = [...el.querySelectorAll('[aria-label]')].map((n) => n.getAttribute('aria-label')!).filter((l) => /'s message, /.test(l));
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every((l) => l.includes("Script's message, "))).toBe(true);
    expect(el.textContent).not.toContain("An agent's message");
  });

  test.skipIf(!hasDom)("a reply's quote of a script's post names Script beside its terminal", async () => {
    const { ReplyQuoteLine } = await import('./components/ReplyQuote');
    const el = await draw(<ReplyQuoteLine message={message('msg_1', SCRIPT, 1, 'Disk at 91% on node 3.')} phone={false} onRemove={() => {}} />);
    const quote = el.querySelector('[data-reply-quote]')!;
    expect(quote.getAttribute('aria-label')).toStartWith("Replying to Script's message");
    expect(quote.textContent).toContain('Script');
    expect(quote.querySelector('[data-script-mark]')).not.toBeNull();
  });

  test.skipIf(!hasDom)("a script's row a Claude Code session took over: every row label names Claude Code, and no terminal is drawn on the row", async () => {
    const { InboxList } = await import('./components/InboxList');
    const { SidebarProvider } = await import('./shell/sidebar');
    const { cardOf, rowRecipient, sentWordsOf } = await import('./components/rowParts');
    const { DraftsPage } = await import('./compose/DraftsPage');
    const stopped = taken('msg_stop', { section: 'stopped', questions: { open: 1, picked: 0, stopped: true, holds_up: [], prompt: 'Clear the snapshots?', actions: 0 }, waits: [{ message_id: 'msg_2', key: 'q-1', position: 0, prompt: 'Clear the snapshots?', stopped: 'The disk fills tonight.', holds_up: [] }] });
    const sent = taken('msg_sent', { section: 'sent', last_author: 'person', sent: SENT, delivery: { ...TO_CLAUDE, send_now: true } });
    const words = taken('msg_words', { section: 'sent', last_author: 'person', sent: SENT });
    const reask = taken('msg_reask', { section: 'sent', last_author: 'person', sent: SENT, reask_pending: true, delivery: TO_CLAUDE });
    const quiet = taken('msg_quiet', { section: 'new' });
    const rows = [stopped, sent, words, reask, quiet];
    const draft: InboxReplyDraftRow = { ...quiet, unsent: { reply_at: '2026-11-23T07:05:00.000Z', picks: 0, comments: 0 }, reply_preview: 'Go ahead.' };
    const el = await draw(
      <SidebarProvider>
        <InboxList title="Inbox" path={null} sections={[{ id: 'new', label: 'New', threads: rows }] as InboxListSection[]} filtered={false} narrow={false} selectedThreadId={null} notice={null} onShowNew={() => {}} onOpen={() => {}} pinned={new Set()} />
        <div data-test-card="">{cardOf(stopped)}</div>
        <DraftsPage drafts={[]} error={null} phone={false} replies={[draft]} onOpenReply={() => {}} onOpen={() => {}} onDelete={() => {}} onCompose={() => {}} />
      </SidebarProvider>,
    );
    for (const r of rows) {
      const rowEl = el.querySelector(`[data-thread-id="${r.thread_id}"]`)!;
      expect(rowEl.querySelector('[data-row-agents]')!.getAttribute('aria-label')).toBe('Claude Code');
      expect(rowEl.querySelector('[data-script-mark]')).toBeNull();
      const labels = [rowEl.textContent ?? '', ...[...rowEl.querySelectorAll('[aria-label]')].map((n) => n.getAttribute('aria-label')!)];
      expect(labels.filter((l) => /Script|An agent/.test(l))).toEqual([]);
      // The tooltips' and lines' name (Send now, Mark read, the wait card, the sent and Re-ask lines).
      expect(rowRecipient(r)).toBe('Claude Code');
    }
    expect(sentWordsOf(words)).toContain('Claude Code');
    expect(sentWordsOf(reask)).toContain('Claude Code');
    // The badge's hover card: the agent's name and its mark.
    const card = el.querySelector('[data-test-card]')!;
    expect(card.textContent).toContain('Claude Code');
    expect(card.textContent).not.toContain('Script');
    expect(card.querySelector('[data-script-mark]')).toBeNull();
    // Drafts: whom the unsent reply goes to.
    expect(el.querySelector('[data-reply-draft]')!.textContent).toContain('Reply to Claude Code');
    expect(el.querySelector('[data-reply-draft] [data-script-mark]')).toBeNull();
  });

  test.skipIf(!hasDom)('an agent with a session but no known name or host still reads "An agent" with the neutral mark', async () => {
    const { ThreadPane } = await import('./components/Thread');
    const el = await draw(<ThreadPane thread={thread([message('msg_1', SHIM, 1, 'Which queue should I drain first?')])} {...threadProps} />);
    const article = el.querySelector('[data-message-article="msg_1"]')!;
    expect(article.querySelector('.ib-fl-nm')!.textContent).toBe('An agent');
    expect(article.querySelector('[data-script-mark]')).toBeNull();
    expect(article.querySelector('svg[data-icon="code"]')).not.toBeNull();
  });
});
