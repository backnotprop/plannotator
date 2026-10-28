/**
 * The replies one Send makes (pure, for the tests): the agent messages it
 * answers, and which reply each waiting annotation rides.
 */
import { inboxActionInDraft, type InboxAnnotationRecord, type InboxMessageWire, type InboxThread } from '@plannotator/core/inbox-types';

/**
 * One reply of a Send: the message it answers, its picks and the questions it
 * skips, on any of that session's messages (one Send to one session is one
 * reply, approval "inbox-explicit-skip", 2026-10-21). A pick or skip on
 * another message than `message` names it with `message_id`.
 */
export interface SendTarget {
  message: InboxMessageWire;
  questions: { message_id?: string; key: string; revision: number }[];
  skip: { message_id?: string; key: string }[];
  /** The action items whose Done or Can't do it waits in the draft (approval "inbox-action-items-in-reply"). */
  actions: { message_id?: string; key: string }[];
}

/**
 * Where each waiting annotation goes (review of #1997): a comment on an agent
 * message's text goes to the session that wrote that message. One whose
 * message the last reply already reaches (that message, or one its session
 * wrote) rides the last reply with the words, the file and the guide
 * comments; any other rides a reply to its own message, which joins the
 * targets in thread order when it is not one already (a comment never goes
 * to two replies). Returns the targets and the annotations each carries,
 * keyed by the message the reply answers.
 */
export function routeSendAnnotations(
  thread: InboxThread,
  targets: readonly SendTarget[],
  records: readonly InboxAnnotationRecord[],
): { targets: SendTarget[]; carried: Map<string, InboxAnnotationRecord[]> } {
  const carried = new Map<string, InboxAnnotationRecord[]>();
  const last = targets.at(-1);
  if (!last) return { targets: [...targets], carried };
  const put = (id: string, record: InboxAnnotationRecord) => carried.set(id, [...(carried.get(id) ?? []), record]);
  const extra: SendTarget[] = [];
  for (const record of records) {
    const message = record.message ? thread.messages.find((m) => m.id === record.message_id) : undefined;
    if (!message || message.id === last.message.id || sameSession(message, last.message)) {
      put(last.message.id, record);
      continue;
    }
    // A reply already going to that message's session carries it (one reply per session).
    const going = [...targets, ...extra].find((t) => t.message.id === message.id || sameSession(t.message, message));
    if (going) {
      put(going.message.id, record);
      continue;
    }
    extra.push({ message, questions: [], skip: [], actions: [] });
    put(message.id, record);
  }
  if (extra.length === 0) return { targets: [...targets], carried };
  const order = new Map(thread.messages.map((m, index) => [m.id, index]));
  const before = [...targets.slice(0, -1), ...extra].sort((a, b) => (order.get(a.message.id) ?? 0) - (order.get(b.message.id) ?? 0));
  return { targets: [...before, last], carried };
}

/** Two agent messages one session wrote (a message with no session matches none). */
export function sameSession(a: InboxMessageWire, b: InboxMessageWire): boolean {
  if (a.author.kind !== 'agent' || b.author.kind !== 'agent') return false;
  return !!a.author.session && a.author.session === b.author.session && (a.author.host ?? '') === (b.author.host ?? '');
}

/**
 * The replies a Send makes, in thread order: ONE per agent session it answers
 * (approval "inbox-explicit-skip", 2026-10-21), carrying every pick waiting
 * on that session's messages and the questions the person chose to skip
 * (`skip`: ids `<message id>/<key>`, from "Skip them"; empty, the default,
 * skips nothing). A Send never skips on its own. Each reply answers the
 * latest of that session's messages it touches; a message with no session
 * is a reply of its own. The person's words (which ride the last reply) go
 * to the agent that wrote most recently, never to an older asker: when the
 * latest agent message's session has a reply, that reply comes last;
 * otherwise the latest agent message comes last, with nothing of its own.
 */
export function sendTargetsOf(thread: InboxThread, skip: ReadonlySet<string> = new Set()): SendTarget[] {
  const groups = new Map<string, SendTarget>();
  for (const m of thread.messages) {
    if (m.author.kind !== 'agent') continue;
    const picks = (m.questions ?? []).filter((q) => q.state === 'picked');
    const skips = (m.questions ?? []).filter((q) => q.state === 'open' && skip.has(`${m.id}/${q.key}`));
    const drafted = (m.actions ?? []).filter((a) => inboxActionInDraft(a));
    if (picks.length === 0 && skips.length === 0 && drafted.length === 0) continue;
    const group = groupKey(m);
    const target = groups.get(group) ?? { message: m, questions: [], skip: [], actions: [] };
    target.questions.push(...picks.map((q) => ({ message_id: m.id, key: q.key, revision: q.revision })));
    target.skip.push(...skips.map((q) => ({ message_id: m.id, key: q.key })));
    target.actions.push(...drafted.map((a) => ({ message_id: m.id, key: a.key })));
    // The reply answers the latest message of the session it touches (thread order: the last seen).
    target.message = m;
    groups.set(group, target);
  }
  // Each answer on the reply's own message names no message (the route's default).
  let targets = [...groups.values()].map((t) => ({
    message: t.message,
    questions: t.questions.map((q) => (q.message_id === t.message.id ? { key: q.key, revision: q.revision } : q)),
    skip: t.skip.map((q) => (q.message_id === t.message.id ? { key: q.key } : q)),
    actions: t.actions.map((a) => (a.message_id === t.message.id ? { key: a.key } : a)),
  }));
  const order = new Map(thread.messages.map((m, index) => [m.id, index]));
  targets.sort((a, b) => (order.get(a.message.id) ?? 0) - (order.get(b.message.id) ?? 0));
  const latest = thread.messages.filter((m) => m.author.kind === 'agent').at(-1) ?? thread.messages[0]!;
  const words = targets.findIndex((t) => t.message.id === latest.id || sameSession(t.message, latest));
  if (words < 0) targets.push({ message: latest, questions: [], skip: [], actions: [] });
  else targets = [...targets.slice(0, words), ...targets.slice(words + 1), targets[words]!];
  return targets;
}

/** The reply a message's questions ride: its session's, or its own when it has none. */
function groupKey(m: InboxMessageWire): string {
  return m.author.kind === 'agent' && m.author.session ? `s:${m.author.host ?? ''}\u0000${m.author.session}` : `m:${m.id}`;
}

/** What one reply of a Send carried, for a retry's key (`replyKeysToRenew`). */
export interface SentContents {
  /** The message it answers and what rides it besides answers (words, files, tags, comments), as a string. */
  value: string;
  /** Its picks (`a:<message id>/<key>`) and skips (`s:…`). */
  answers: string[];
}

/** A reply's picks and skips, as `SentContents.answers` lists them. */
export function sendTargetAnswerIds(target: SendTarget): string[] {
  return [
    ...target.questions.map((q) => `a:${q.message_id ?? target.message.id}/${q.key}`),
    ...target.skip.map((q) => `s:${q.message_id ?? target.message.id}/${q.key}`),
    ...target.actions.map((a) => `x:${a.message_id ?? target.message.id}/${a.key}`),
  ];
}

/**
 * The replies of a retried Send that must take a new idempotency key: one
 * whose words, files or comments changed, or that carries a pick or a skip
 * the last try did not (a replay of the old key would answer the old reply
 * and drop the new answer). A pick that went with the last try is sent now
 * and only leaves the list, which keeps the key, so a reply that went with
 * its answer lost is replayed, not written twice.
 */
export function replyKeysToRenew(before: ReadonlyMap<string, SentContents> | null, now: ReadonlyMap<string, SentContents>): string[] {
  if (!before) return [];
  const renew: string[] = [];
  for (const [id, next] of now) {
    const last = before.get(id);
    if (last && (last.value !== next.value || next.answers.some((a) => !last.answers.includes(a)))) renew.push(id);
  }
  return renew;
}
