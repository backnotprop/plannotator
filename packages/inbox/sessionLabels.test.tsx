/**
 * Session labels past the To picker (issue #2450): the `@` picker's rows and the
 * `@` token, a list row's agents, Send to another session, and an agent
 * message's author, all from one map (the list's `session_labels`) or the
 * route's own `label`. The failures this catches: an unnamed session that reads
 * any differently than before; two sessions named alike (or a session named
 * "Pi") becoming the same `@` token; a label too long for the reply route's tag
 * or for a phone's line; a row's agents that never say the name; a message whose
 * author drops the agent's name or never adds the session's (owner's decision,
 * "Claude Code · Fix login redirect"), or that keeps a name the list no longer
 * gives; and a window that never reads the list again
 * when only a label changed.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 * The pure parts run without it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InboxAuthor, InboxMessageWire, InboxParticipant, InboxProject, InboxThread } from '@plannotator/core/inbox-types';
import { dispatchInboxFrame, type LiveSessionsModel, type TaggableModel, type TaggableSession } from './api';
import { rowAgentGroups, rowAgentWords } from './components/RowAgents';
import { labelOf, setSessionLabels, shortLabel } from './sessionLabels';
import { TAG_LABEL_MAX, tagOptions } from './tags';

const hasDom = typeof document !== 'undefined';
const time = () => '9:14 AM';

function live(session: string, host: string, label?: string, extra: Partial<TaggableSession> = {}): TaggableSession {
  return {
    session,
    host,
    kind: 'live',
    name: null,
    ...(label === undefined ? {} : { label }),
    project: { id: 'prj_1', name: 'ai-collab', root: '/w/ai-collab' },
    started_at: '2026-11-03T09:00:00.000Z',
    last_at: '2026-11-03T09:10:00.000Z',
    busy: false,
    idle_since: null,
    taggable: true,
    owner: false,
    wrote_thread: false,
    ...extra,
  };
}

const model = (sessions: TaggableSession[], owner: string | null = null): TaggableModel => ({ serverSession: 's', owner: owner ? { host: 'claude-code', session: owner } : null, sessions });
const labelsOf = (m: TaggableModel, owner: string | null = null) => Object.fromEntries(tagOptions(m, owner, 'prj_1', time).map((o) => [o.id, o.label]));
const withoutLabels = (sessions: TaggableSession[]) => sessions.map(({ label: _label, ...rest }) => rest as TaggableSession);

describe('the @ picker', () => {
  test('a named session is offered by its name; an unnamed one reads exactly as it did with no names at all', () => {
    const sessions = [live('ses-owner', 'claude-code', 'Fix login redirect'), live('ses-docs', 'claude-code', 'Docs pass'), live('ses-plain', 'claude-code'), live('ses-pi', 'pi')];
    const named = labelsOf(model(sessions, 'ses-owner'), 'ses-owner');
    // The unnamed one keeps the words an unnamed session has always had beside another of its agent.
    expect(named).toEqual({ 'ses-owner': 'Fix login redirect', 'ses-docs': 'Docs pass', 'ses-plain': 'Claude Code (another session)', 'ses-pi': 'Pi' });
    // With no names at all, every row reads as it did before labels (the strings the earlier picker gave).
    expect(labelsOf(model(withoutLabels(sessions), 'ses-owner'), 'ses-owner')).toEqual({
      'ses-owner': 'Claude Code',
      'ses-docs': 'Claude Code (another session)',
      'ses-plain': 'Claude Code (another session 2)',
      'ses-pi': 'Pi',
    });
  });

  test('names never collide as tokens: two alike, or a name that reads as another row, say their agent', () => {
    const labels = labelsOf(model([live('a', 'claude-code', 'Review'), live('b', 'claude-code', 'Review'), live('c', 'claude-code', 'Pi'), live('d', 'pi')]));
    expect(labels).toEqual({ a: 'Review (Claude Code)', b: 'Review (Claude Code 2)', c: 'Pi (Claude Code)', d: 'Pi' });
    const across = labelsOf(model([live('a', 'claude-code', 'Review'), live('e', 'pi', 'Review')]));
    expect(across).toEqual({ a: 'Review (Claude Code)', e: 'Review (Pi)' });
  });

  test('a long name is cut in the middle, both ends kept, short enough for the reply route; markup stays text', () => {
    const long = `Investigate the flaky ${'very '.repeat(8)}long checkout test`;
    const [option] = tagOptions(model([live('a', 'claude-code', long)]), null, 'prj_1', time);
    expect(Array.from(option!.label).length).toBeLessThanOrEqual(TAG_LABEL_MAX);
    expect(option!.label.startsWith('Investigate the')).toBe(true);
    expect(option!.label.endsWith('checkout test')).toBe(true);
    expect(option!.label).toContain('…');
    const [markup] = tagOptions(model([live('a', 'claude-code', '<img src=x onerror=alert(1)> [x](y)')]), null, 'prj_1', time);
    expect(markup!.label).toBe('<img src=x onerror=alert(1)> x (y)');
  });

  test('only a live session has a label: an MCP agent keeps the name it gave itself', () => {
    const reader: TaggableSession = { ...live('m', 'codex', 'Should not show'), kind: 'mcp', name: 'Codex' };
    expect(labelsOf(model([reader]))).toEqual({ m: 'Codex' });
  });
});

describe("a row's agents in words", () => {
  const p = (host: string, session: string): InboxParticipant => ({ host, session });
  const agent = { kind: 'agent', host: 'claude-code', session: 'ses-a' };
  test('named sessions say their names; unnamed ones read as before', () => {
    const participants = [p('claude-code', 'ses-a'), p('claude-code', 'ses-b'), p('claude-code', 'ses-c'), p('pi', 'ses-pi')];
    const labels = { 'ses-a': 'Fix login redirect', 'ses-b': 'Docs pass' };
    expect(rowAgentWords(rowAgentGroups(participants, agent, labels))).toBe('3 Claude Code sessions (Fix login redirect, Docs pass, 1 unnamed) and Pi');
    expect(rowAgentWords(rowAgentGroups(participants, agent))).toBe('3 Claude Code sessions and Pi');
    // One agent, no participants: the row's own author.
    expect(rowAgentWords(rowAgentGroups(undefined, agent, labels))).toBe('Fix login redirect (Claude Code)');
    expect(rowAgentWords(rowAgentGroups(undefined, agent, {}))).toBe('Claude Code');
  });

  test('a long name is cut in the middle in the words', () => {
    const words = rowAgentWords(rowAgentGroups(undefined, agent, { 'ses-a': `Start ${'x'.repeat(50)} end` }));
    expect(words).toBe(`${shortLabel(`Start ${'x'.repeat(50)} end`, 32)} (Claude Code)`);
    expect(words).toContain('…');
  });
});

test('shortLabel keeps whole characters at both ends', () => {
  expect(shortLabel('short')).toBe('short');
  const cut = shortLabel(`${'\u{1F600}'.repeat(30)}tail`, 10);
  expect(Array.from(cut)).toHaveLength(10);
  // No lone surrogate: every UTF-16 high half is followed by its low half.
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut)).toBe(false);
  expect(cut.endsWith('tail')).toBe(true);
});

test('shortLabel never splits a family emoji, wherever the cut falls', () => {
  // Seven code points, one character: a code-point cut leaves a man, or a ZWJ, on either side of the "…".
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  const whole = (text: string) => Array.from(segmenter.segment(text), (s) => s.segment).every((g) => !g.includes('\u200D') || g === family);
  // max 10 keeps 5 at the head and 4 at the tail: put the family at each edge of each kept end, and at the cut itself.
  for (let at = 0; at < 20; at += 1) {
    const chars = Array.from('abcdefghijklmnopqrst');
    chars[at] = family;
    const cut = shortLabel(chars.join(''), 10);
    expect(Array.from(segmenter.segment(cut))).toHaveLength(10);
    expect(whole(cut), `family at ${at}: ${cut}`).toBe(true);
    expect(cut.split(family).length - 1).toBe(at < 5 || at >= 16 ? 1 : 0);
  }
});

test('the deliveries frame says when a label changed; an older frame is a delivery change alone', () => {
  const seen: unknown[] = [];
  const handlers = { onStatus: () => {}, onRecord: () => {}, onDeliveries: (change?: { labels: boolean }) => seen.push(change) } as never;
  dispatchInboxFrame({ name: 'deliveries', data: '{"labels":true}', id: null }, handlers);
  dispatchInboxFrame({ name: 'deliveries', data: '{}', id: null }, handlers);
  dispatchInboxFrame({ name: 'deliveries', data: '', id: null }, handlers);
  expect(seen).toEqual([{ labels: true, sessions: false, agents: false }, { labels: false, sessions: false, agents: false }, { labels: false, sessions: false, agents: false }]);
});

// --- Drawn ---------------------------------------------------------------------------------------------------------

const PROJECT: InboxProject = { id: 'prj_1', key: 'ai-collab-abcdef', name: 'ai-collab', root: '/w/ai-collab', created_at: '2026-11-03T09:00:00.000Z' };
const claude = (session: string): InboxAuthor => ({ kind: 'agent', host: 'claude-code', session, name: 'Claude Code' });

function message(id: string, author: InboxAuthor, seq: number, body: string): InboxMessageWire {
  return {
    id,
    project_id: PROJECT.id,
    thread_id: 'msg_1',
    reply_to: id === 'msg_1' ? null : 'msg_1',
    author,
    subject: id === 'msg_1' ? 'Login loops after SSO' : null,
    body,
    created_at: `2026-11-03T09:${String(seq).padStart(2, '0')}:00.000Z`,
    resolved_at: null,
    idempotency_key: null,
    seq,
  };
}

const THREAD: InboxThread = {
  thread_id: 'msg_1',
  project: PROJECT,
  subject: 'Login loops after SSO',
  thread_name: null,
  resolved_at: null,
  messages: [
    message('msg_1', claude('ses-login'), 1, 'The redirect loops after SSO.'),
    message('msg_2', claude('ses-docs'), 2, 'The README says the opposite.'),
    message('msg_3', claude('ses-plain'), 3, 'Billing reads the same cookie.'),
  ],
};

let root: Root | null = null;
let host: HTMLElement | null = null;
let savedFetch: typeof fetch;

beforeEach(() => {
  if (!hasDom) return;
  savedFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes('/attachments')) return Response.json({ serverSession: 's', attachments: [], annotations: [] });
    if (path.includes('/sessions')) return Response.json({ home: null, project: PROJECT, sessions: [] });
    return Response.json({});
  }) as typeof fetch;
});

afterEach(() => {
  if (hasDom) {
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    globalThis.fetch = savedFetch;
  }
  setSessionLabels(undefined);
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

describe('drawn', () => {
  test.skipIf(!hasDom)("a named session's message keeps its agent's name and adds the label after it; the unnamed one is untouched; a cleared name goes", async () => {
    const { ThreadPane } = await import('./components/Thread');
    const long = 'Fix the login redirect loop for SSO users on the admin console';
    setSessionLabels({ 'ses-login': 'Fix login redirect', 'ses-docs': long, 'ses-other': 'Not in this thread' });
    const el = await draw(<ThreadPane thread={THREAD} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} />);
    const nameOf = (id: string) => el.querySelector(`[data-message-article="${id}"] .ib-fl-nm`)!;
    // Both names, the agent first, the label in its own quieter part.
    expect(nameOf('msg_1').textContent).toBe('Claude Code · Fix login redirect');
    expect(nameOf('msg_1').querySelector('[data-author-agent]')!.textContent).toBe('Claude Code');
    expect(nameOf('msg_1').querySelector('.ib-fl-lbl [data-author-label]')!.textContent).toBe('Fix login redirect');
    expect(nameOf('msg_1').hasAttribute('data-session-label')).toBe(true);
    // A long label is cut in the middle, both ends kept; the agent's name is whole.
    expect(nameOf('msg_2').querySelector('[data-author-agent]')!.textContent).toBe('Claude Code');
    expect(nameOf('msg_2').querySelector('[data-author-label]')!.textContent).toBe(shortLabel(long, 32));
    expect(nameOf('msg_2').querySelector('[data-author-label]')!.textContent).toStartWith('Fix the login');
    expect(nameOf('msg_2').querySelector('[data-author-label]')!.textContent).toEndWith('console');
    // Unnamed: the same element and words as before.
    expect(nameOf('msg_3').textContent).toBe('Claude Code');
    expect(nameOf('msg_3').hasAttribute('data-session-label')).toBe(false);
    expect(nameOf('msg_3').querySelector('.ib-fl-lbl')).toBeNull();
    expect(el.querySelector('[data-message-article="msg_3"] [data-fold-head]')!.getAttribute('aria-label')).toStartWith('Claude Code, ');
    expect(el.querySelector('.ib-pbody')!.hasAttribute('data-session-labels')).toBe(true);
    // A screen reader hears both names, the whole label, on the fold button (folded and open heads alike).
    for (const id of ['msg_1', 'msg_2']) {
      const want = id === 'msg_1' ? 'Claude Code (Fix login redirect), ' : `Claude Code (${long}), `;
      expect(el.querySelector(`[data-message-article="${id}"] [data-fold-head]`)!.getAttribute('aria-label')).toStartWith(want);
    }

    act(() => setSessionLabels({}));
    expect(nameOf('msg_1').textContent).toBe('Claude Code');
    expect(nameOf('msg_1').querySelector('.ib-fl-lbl')).toBeNull();
    expect(el.querySelector('.ib-pbody')!.hasAttribute('data-session-labels')).toBe(false);
  });

  test.skipIf(!hasDom)("a one-message thread's open head says both names to a screen reader, the whole label", async () => {
    const { ThreadPane } = await import('./components/Thread');
    const long = 'Fix the login redirect loop for SSO users on the admin console';
    setSessionLabels({ 'ses-login': long });
    const thread: InboxThread = { ...THREAD, messages: [THREAD.messages[0]!] };
    const el = await draw(<ThreadPane thread={thread} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} />);
    const name = el.querySelector('[data-message-article="msg_1"] .ib-fl-nm.ib-who')!;
    expect(name.hasAttribute('aria-hidden')).toBe(false);
    // What is drawn (the cut label) is hidden; what is heard has both names and the whole label.
    expect(name.querySelector('[data-author-agent]')!.getAttribute('aria-hidden')).toBe('true');
    expect(name.querySelector('.ib-fl-lbl')!.getAttribute('aria-hidden')).toBe('true');
    expect(name.querySelector('.ib-sr')!.textContent).toBe(`Claude Code (${long})`);
  });

  test.skipIf(!hasDom)("a row's agents say the names in their accessible name", async () => {
    const { RowAgents, RowAgentTiles } = await import('./components/RowAgents');
    setSessionLabels({ 'ses-login': 'Fix login redirect' });
    const participants: InboxParticipant[] = [{ host: 'claude-code', session: 'ses-login' }, { host: 'claude-code', session: 'ses-plain' }];
    const el = await draw(
      <>
        <RowAgents participants={participants} agent={{ kind: 'agent', host: 'claude-code' }} tip={false} />
        <RowAgentTiles participants={undefined} agent={{ kind: 'agent', host: 'claude-code', session: 'ses-plain' }} tip={false} />
      </>,
    );
    const names = [...el.querySelectorAll('[role="img"]')].map((node) => node.getAttribute('aria-label'));
    expect(names).toEqual(['2 Claude Code sessions (Fix login redirect, 1 unnamed)', 'Claude Code']);
  });

  test.skipIf(!hasDom)('Send to another session names a named session by its label, and an unnamed one as before', async () => {
    const { SendToAnotherSession } = await import('./compose/SendToAnotherSession');
    const sessions = [
      { session: 'ses-docs', host: 'claude-code', started_at: '2026-11-03T09:00:00.000Z', last_seen_at: '2026-11-03T09:10:00.000Z', busy: false, idle_since: null, wrote_thread: true, label: 'Docs pass' },
      { session: 'ses-plain', host: 'claude-code', started_at: '2026-11-03T09:00:00.000Z', last_seen_at: '2026-11-03T09:10:00.000Z', busy: true, idle_since: null, wrote_thread: false },
    ];
    const liveModel = { serverSession: 's', home: '/home/me', project: PROJECT, sessions } as LiveSessionsModel;
    const el = await draw(<SendToAnotherSession messageId="msg_9" ended={{ host: 'claude-code', session: 'ses-login' }} project="ai-collab" live={liveModel} onReload={async () => {}} onMoved={async () => {}} />);
    act(() => el.querySelector<HTMLButtonElement>('[data-readdress-open]')!.click());
    const named = el.querySelector('[data-readdress-session="ses-docs"]')!;
    expect(named.querySelector('[data-session-label]')!.textContent).toBe('Docs pass');
    expect(named.querySelector('.ib-d')!.textContent).toContain('Claude Code');
    const plain = el.querySelector('[data-readdress-session="ses-plain"]')!;
    expect(plain.querySelector('[data-session-label]')).toBeNull();
    expect(plain.querySelector('.ib-t')!.textContent).toStartWith('Claude Code · started');
    expect(el.querySelector('[data-readdress-send]')!.textContent).toBe('Send to Docs pass');
  });

  test.skipIf(!hasDom)('two sessions with one label each say their agent first, in the rows and on the button', async () => {
    const { SendToAnotherSession } = await import('./compose/SendToAnotherSession');
    const row = (session: string, host: string, label: string) => ({ session, host, started_at: '2026-11-03T09:00:00.000Z', last_seen_at: '2026-11-03T09:10:00.000Z', busy: false, idle_since: null, wrote_thread: false, label });
    const sessions = [row('ses-a', 'claude-code', 'Review'), row('ses-b', 'pi', 'review '), row('ses-c', 'claude-code', 'Docs pass')];
    const liveModel = { serverSession: 's', home: '/home/me', project: PROJECT, sessions } as LiveSessionsModel;
    const el = await draw(<SendToAnotherSession messageId="msg_9" ended={{ host: 'claude-code', session: 'ses-login' }} project="ai-collab" live={liveModel} onReload={async () => {}} onMoved={async () => {}} />);
    act(() => el.querySelector<HTMLButtonElement>('[data-readdress-open]')!.click());
    const top = (session: string) => el.querySelector(`[data-readdress-session="${session}"] [data-session-label]`)!.textContent;
    expect(top('ses-a')).toBe('Claude Code · Review');
    expect(top('ses-b')).toBe('Pi · review ');
    expect(top('ses-c')).toBe('Docs pass');
    expect(el.querySelector('[data-readdress-send]')!.textContent).toBe('Send to Claude Code · Review');
  });
});

describe('a session id that is a name Object has', () => {
  test('lookups find nothing in the prototype', () => {
    // A plain object, as a caller might pass: its prototype's names are no labels.
    const labels: Record<string, string> = { 'ses-a': 'Fix login' };
    for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) expect(labelOf(labels, id)).toBeNull();
    expect(labelOf(labels, 'ses-a')).toBe('Fix login');
    // A list whose map really carries "__proto__" (JSON.parse makes it an own key) reads it as a label.
    expect(labelOf(JSON.parse('{"__proto__":"Proto named"}'), '__proto__')).toBe('Proto named');
  });

  test.skipIf(!hasDom)('a "constructor" session with no labels renders exactly as it does with none at all', async () => {
    const { ThreadPane } = await import('./components/Thread');
    const { RowAgents } = await import('./components/RowAgents');
    const thread: InboxThread = { ...THREAD, messages: [message('msg_1', claude('constructor'), 1, 'Hello.'), message('msg_2', claude('toString'), 2, 'Again.')] };
    const participants: InboxParticipant[] = [{ host: 'claude-code', session: 'constructor' }, { host: 'claude-code', session: 'toString' }];
    setSessionLabels({});
    const el = await draw(
      <>
        <RowAgents participants={participants} agent={{ kind: 'agent', host: 'claude-code', session: 'constructor' }} tip={false} />
        <RowAgents participants={undefined} agent={{ kind: 'agent', host: 'claude-code', session: 'constructor' }} tip={false} />
        <ThreadPane thread={thread} sent={null} onQuestions={() => {}} onChanged={async () => {}} onClose={() => {}} file={null} onOpenFile={() => {}} onOpenGuide={() => {}} />
      </>,
    );
    expect([...el.querySelectorAll('[role="img"][data-row-agents]')].map((node) => node.getAttribute('aria-label'))).toEqual(['2 Claude Code sessions', 'Claude Code']);
    expect([...el.querySelectorAll('.ib-fl-nm')].map((node) => node.textContent)).toEqual(['Claude Code', 'Claude Code']);
    expect(el.querySelector('[data-session-label]')).toBeNull();
    expect(el.querySelector('.ib-pbody')!.hasAttribute('data-session-labels')).toBe(false);
    expect(el.textContent).not.toContain('native code');
    expect(el.querySelector('[data-message-article="msg_1"] [data-fold-head]')!.getAttribute('aria-label')).toStartWith('Claude Code, ');
  });
});
