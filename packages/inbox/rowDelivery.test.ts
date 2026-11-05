/**
 * The row's delivery glyph and the thread's delivery line are one rule
 * (`inboxDeliveryState`): for every combination of what the Inbox knows,
 * the state the server puts on the row is the line's state, and the row's
 * tooltip is the line word for word.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inboxAgentName, inboxAskingMessage, inboxDefaultSkip, type InboxMessageWire, type InboxQuestion } from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { InboxStore } from '../shared/inbox/store';
import { inboxDeliveryState, type InboxListRow, type InboxListSection, type InboxRowDelivery } from '@plannotator/core/inbox-types';
import { deliveryLine, waitInputs, type DeliveryLineInput, type RecipientConnection } from './deliveryLine';
import { deliveriesReadList, hasMovingDelivery, rowDeliveryLine, rowDeliveryName, rowDeliverySpoken, rowTimeIso } from './rowDelivery';

const time = (iso: string) => `at ${iso.slice(11, 16)}`;
const AT = '2026-10-20T15:41:00.000Z';

const connections: (RecipientConnection | null | undefined)[] = [
  undefined,
  null,
  { busy: true, idle_since: null, send_now: true },
  { busy: true, idle_since: null, send_now: false },
  { busy: false, idle_since: AT, send_now: false },
  { busy: null, idle_since: null, send_now: false },
];

function* inputs(): Generator<DeliveryLineInput> {
  for (const delivered of [false, true])
    for (const undelivered of [false, true])
      for (const ended of [false, true])
        for (const wakes of [false, true])
          for (const sendingNow of [false, true])
            for (const connection of connections) {
              yield {
                name: 'Claude Code',
                deliveredAt: delivered ? AT : null,
                time,
                wakes,
                sendingNow,
                connection,
                askerEnded: ended ? { name: 'Claude Code' } : null,
                undelivered: undelivered ? { host: 'Claude Code' } : null,
              };
            }
}

/** What the server puts on the row for the same facts. */
function rowFor(input: DeliveryLineInput): InboxRowDelivery {
  const decision = inboxDeliveryState({
    delivered: !!input.deliveredAt,
    undelivered: !!input.undelivered,
    askerEnded: !!input.askerEnded,
    wakes: input.wakes,
    sendingNow: input.sendingNow,
    connection: input.connection,
  });
  return { kind: 'reply', state: decision.state, reason: decision.reason, send_now: decision.sendNow, message_id: 'msg_x', at: input.deliveredAt, host: 'claude-code', name: null };
}

describe('the row and the thread agree', () => {
  test('every case: the same state, Send now, and the tooltip is the thread line', () => {
    let count = 0;
    for (const input of inputs()) {
      const line = deliveryLine(input);
      const row = rowFor(input);
      expect(row.state).toBe(line.state);
      expect(row.send_now).toBe(line.sendNow === true);
      expect(rowDeliveryLine(row, time)).toBe(line.text);
      count += 1;
    }
    expect(count).toBe(2 * 2 * 2 * 2 * 2 * connections.length);
  });

  test('each state is reached', () => {
    const states = new Set([...inputs()].map((input) => deliveryLine(input).state));
    expect([...states].sort()).toEqual(['delivered', 'queued', 'saved', 'sending', 'undelivered']);
  });
});

const base: InboxRowDelivery = { kind: 'reply', state: 'queued', reason: 'working', send_now: true, message_id: 'msg_x', at: null, host: 'claude-code', name: null };

describe('the row words', () => {
  test('whom: the host, an MCP agent by its own name, another session', () => {
    expect(rowDeliveryName(base)).toBe('Claude Code');
    expect(rowDeliveryName({ ...base, host: 'codex', name: 'Codex (review)' })).toBe('Codex (review)');
    expect(rowDeliveryName({ ...base, another_session: true })).toBe('Claude Code (another session)');
  });

  test('the state in words for the accessible name, a 👍 says so', () => {
    expect(rowDeliverySpoken(base)).toBe('Queued for Claude Code');
    expect(rowDeliverySpoken({ ...base, state: 'sending' })).toBe('Sending to Claude Code');
    expect(rowDeliverySpoken({ ...base, state: 'saved' })).toBe('Saved for Claude Code');
    expect(rowDeliverySpoken({ ...base, state: 'delivered' })).toBe('Delivered to Claude Code');
    expect(rowDeliverySpoken({ ...base, state: 'undelivered' })).toBe('Not delivered');
    expect(rowDeliverySpoken({ ...base, kind: 'ack', state: 'queued' })).toBe('Looks good, queued for Claude Code');
  });

  test("a 👍's tooltip, in its Undo window and after", () => {
    expect(rowDeliveryLine({ ...base, kind: 'ack', reason: 'ack_pending' })).toBe('👍 Looks good · Goes to Claude Code in a few seconds');
    expect(rowDeliveryLine({ ...base, kind: 'ack', state: 'sending', reason: 'idle' })).toBe('👍 Looks good · Sending to Claude Code…');
  });

  test('the time is the delivery time once delivered', () => {
    const row = { last_at: '2026-10-20T15:00:00.000Z', delivery: null } as unknown as InboxListRow;
    expect(rowTimeIso(row)).toBe('2026-10-20T15:00:00.000Z');
    expect(rowTimeIso({ ...row, delivery: { ...base, state: 'delivered', reason: 'delivered', at: AT } })).toBe(AT);
    expect(rowTimeIso({ ...row, delivery: { ...base, state: 'queued' } })).toBe('2026-10-20T15:00:00.000Z');
  });

  test('the list reads again on `deliveries` only while some delivery can move', () => {
    const section = (deliveries: (InboxRowDelivery | null | undefined)[]): InboxListSection[] => [
      { id: 'sent', label: 'Sent', threads: deliveries.map((delivery) => ({ delivery }) as unknown as InboxListRow) },
    ];
    expect(hasMovingDelivery(null)).toBe(false);
    expect(hasMovingDelivery(section([null, undefined]))).toBe(false);
    expect(hasMovingDelivery(section([{ ...base, state: 'delivered' }]))).toBe(false);
    for (const state of ['queued', 'sending', 'undelivered'] as const) expect(hasMovingDelivery(section([{ ...base, state }]))).toBe(true);
    // Saved because the session that asked ended: its coming back moves it. Saved for an agent that reads: only its read does.
    expect(hasMovingDelivery(section([{ ...base, state: 'saved', reason: 'ended' }]))).toBe(true);
    expect(hasMovingDelivery(section([{ ...base, state: 'saved', reason: 'reads' }]))).toBe(false);
  });

  test('a session that ended or came back reads the list again even when no row has a reply to move', () => {
    const section = (deliveries: (InboxRowDelivery | null)[]): InboxListSection[] => [
      { id: 'sent', label: 'Sent', threads: deliveries.map((delivery) => ({ delivery }) as unknown as InboxListRow) },
    ];
    const quiet = section([null, { ...base, state: 'delivered' }]);
    expect(deliveriesReadList({ labels: false, sessions: false }, quiet)).toBe(false);
    expect(deliveriesReadList({ labels: false, sessions: true }, quiet)).toBe(true);
    expect(deliveriesReadList({ labels: true, sessions: false }, quiet)).toBe(true);
    expect(deliveriesReadList(undefined, section([{ ...base, state: 'queued' }]))).toBe(true);
  });
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('a thread with two sessions: the row and the thread line agree on who asked', () => {
  /**
   * The thread's own gathering for a reply without `to` (Thread.tsx): the
   * shared asking rule over the wire with the default skip, the reply's
   * session's connection, and the asker grace; then `deliveryLine`.
   */
  function threadLine(thread: { messages: InboxMessageWire[]; resolved_at: string | null }, sentCheckedAt: string | null, live: { connection: (s: string) => RecipientConnection | null; askerLive: (s: string) => boolean }) {
    const root = thread.messages[0]!;
    const last = thread.messages.at(-1)!;
    const repliedTo = thread.messages.find((m) => m.id === last.reply_to)!;
    const replySession = repliedTo.author.kind === 'agent' ? repliedTo.author.session : null;
    const connection = replySession && !last.delivery && !sentCheckedAt ? live.connection(replySession) : undefined;
    // The thread's default skip with nothing being saved (`sendAnswersAny`), and its asking rule: both the shared ones.
    const statesOf = (m: InboxMessageWire) => (m.questions ?? []).map((q) => q.state);
    const asking = inboxAskingMessage(thread.messages, statesOf, inboxDefaultSkip(thread.messages.filter((m) => m.author.kind === 'agent'), statesOf));
    const askingSession = asking?.author.kind === 'agent' ? asking.author.session : null;
    const askerEnded = thread.resolved_at === null && asking?.wakes === true && !!askingSession && !live.askerLive(askingSession);
    // Named for the session the reply goes to (`recipientName`): the agent it answers when that is another
    // session than the thread's first agent, else the thread's agent.
    const first = root.author.kind === 'agent' ? root.author : null;
    const toAnother =
      repliedTo.author.kind === 'agent' &&
      !!first &&
      ((repliedTo.author.session ?? null) !== (first.session ?? null) || (repliedTo.author.host ?? null) !== (first.host ?? null));
    return deliveryLine({
      name: inboxAgentName(toAnother ? repliedTo.author : root.author),
      deliveredAt: sentCheckedAt,
      time,
      wakes: repliedTo.wakes === true || (replySession !== null && connection != null),
      sendingNow: !!last.deliver_now_at,
      connection,
      askerEnded: askerEnded ? { name: inboxAgentName(asking!.author) } : null,
      ...waitInputs(connection, last.id, { ...last, into_turn: last.delivery?.into_turn ?? null }),
    });
  }

  for (const picked of [false, true]) {
    test(picked ? 'a pick waits on the ended session\'s question: saved, naming that agent' : 'no pick: the latest session asked, queued with Send now', () => {
      const dir = mkdtempSync(join(tmpdir(), 'plannotator-inbox-row-vs-line-'));
      roots.push(dir);
      const store = InboxStore.open(dir);
      const project = store.ensureProject({ name: 'ledger', root: '/work/ledger' });
      // The server's clocks for the items waiting on ses_b, as the sessions route and the rows read them.
      const waits: Record<string, { since: string; auto_since: string | null }> = {};
      const connections = new Map<string, RecipientConnection | null>([['ses_b', { busy: true, idle_since: null, send_now: true, waits }]]);
      const live = {
        connection: (s: string) => connections.get(s) ?? null,
        askerLive: (s: string) => s !== 'ses_a',
        waitOf: (s: string, id: string) => (s === 'ses_b' && waits[id] ? { since: waits[id]!.since, autoSince: waits[id]!.auto_since } : null),
      };
      store.setDeliveryPresence(live);
      const body = [':::question', 'Which region?', '', '- [ ] us-east', '- [ ] eu-west', ':::'].join('\n');
      const m1 = store.sendMessage({ project_id: project.id, author: { kind: 'agent', host: 'pi', session: 'ses_a', name: null }, body, wakes: true }).message;
      const m2 = store.sendMessage({ project_id: project.id, author: { kind: 'agent', host: 'claude-code', session: 'ses_b', name: null }, body: 'I can clean up the buckets too.', reply_to: m1.id, wakes: true }).message;
      if (picked) {
        const q = store.questionsOf(m1.id)[0] as InboxQuestion;
        const answer: QuestionAnswer = { v: 1, key: q.key, kind: q.kind as 'single', prompt: q.prompt, selected: ['eu-west'] };
        store.savePicks(m1.id, [{ key: q.key, revision: q.revision, answer }]);
      }
      const sent = store.sendReply(m2.id, { words: 'Clean them up.', idempotency_key: 'k1' }).reply!;
      waits[sent.id] = { since: sent.created_at, auto_since: sent.created_at };
      const row = store.listRow(m1.id)!;
      const line = threadLine(store.windowThread(m1.id)! as never, row.sent?.checked_at ?? null, live);
      expect(row.delivery!.state).toBe(line.state);
      expect(row.delivery!.send_now).toBe(line.sendNow === true);
      expect(rowDeliveryLine(row.delivery!, time)).toBe(line.text);
      expect(line.state).toBe(picked ? 'saved' : 'queued');
      if (picked) expect(line.text).toStartWith('Saved for Pi. That session has ended');
      // The words answer Claude Code's message (ses_b), so they go to it, not to Pi, who started the thread.
      else expect(line.text).toContain('Claude Code is working');
    });
  }
});

