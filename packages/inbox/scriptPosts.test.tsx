/**
 * A script's post (scriptAuthor.ts): an agent message with no session, no host and no name, as
 * `plannotator inbox call send_message` stores it from a cron job or a plain shell. The window draws a terminal where
 * an agent's icon would be and names it "Script" (the owner, 2026-11-23). The failures these catch:
 *   - a script's row or message head still drawing the neutral `</>` and "An agent";
 *   - an agent with a session but no known host or name (a stdio shim's `ses_` agent) read as a script;
 *   - an agent's shell the CLI names (Gemini CLI: a name, no session) read as a script;
 *   - a routine's row, or an agent's row beside a script's, changing;
 *   - the reply box's words changing (out of scope: they stay "Reply to An agent").
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt. The pure parts run without it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxListRow, InboxListSection, InboxMessageWire, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import type { InboxScheduledRow } from '@plannotator/core/inbox-scheduled-types';
import { messageAuthorName, rowIsScript } from './scriptAuthor';
import { rowScriptOf, scriptTip } from './components/RowAgents';

const hasDom = typeof document !== 'undefined';

const SCRIPT: InboxAuthor = { kind: 'agent', host: null, session: null, name: null };
const SHIM: InboxAuthor = { kind: 'agent', host: null, session: 'ses_shim1', name: null };
const GEMINI: InboxAuthor = { kind: 'agent', host: null, session: null, name: 'Gemini CLI' };
const CLAUDE: InboxAuthor = { kind: 'agent', host: 'claude-code', session: 'ses-api', name: 'Claude Code' };

describe('who is a script', () => {
  test('only an agent with no session, host or name, not sent through a waking connection', () => {
    expect(messageAuthorName({ author: SCRIPT })).toBe('Script');
    expect(messageAuthorName({ author: SHIM })).toBe('An agent');
    expect(messageAuthorName({ author: GEMINI })).toBe('Gemini CLI');
    expect(messageAuthorName({ author: CLAUDE })).toBe('Claude Code');
    expect(messageAuthorName({ author: SCRIPT, wakes: true })).toBe('An agent');
    expect(messageAuthorName({ author: { kind: 'person' } as InboxAuthor })).toBe('An agent');
  });

  test("a row's tiles stand for a script only when no session is in the thread; its tooltip says where it posted", () => {
    expect(rowIsScript({}, SCRIPT)).toBe(true);
    expect(rowIsScript({ participants: [{ host: 'claude-code', session: 'ses-api' }, { host: 'pi', session: 'ses-pi' }] }, SCRIPT)).toBe(false);
    expect(rowIsScript({}, SHIM)).toBe(false);
    expect(scriptTip('Script', rowScriptOf({}, SCRIPT, 'billing-svc'))).toBe('Script in billing-svc');
    expect(scriptTip('Claude Code', rowScriptOf({}, CLAUDE, 'billing-svc'))).toBe('Claude Code');
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

  test.skipIf(!hasDom)("a thread a script wrote: the folded and open heads draw the terminal and say Script; the person's reply goes to Script; the reply box's words are unchanged", async () => {
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
    // Out of scope: the reply box names the script's post as before.
    const open = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Reply')!;
    act(() => open.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(el.querySelector('textarea')!.getAttribute('aria-label')).toBe('Reply to An agent');
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
