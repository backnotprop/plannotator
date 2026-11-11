import { inboxActionInDraft, type InboxAnnotationRecord, type InboxMessageWire, type InboxThread } from '@plannotator/core/inbox-types';
import { activeHandoff } from './tags';
import { isInboxPermissionSession } from '@plannotator/core/inbox-permission';

export interface SendTarget {
  message: InboxMessageWire;
  questions: { message_id?: string; key: string; revision: number }[];
  skip: { message_id?: string; key: string }[];
  actions: { message_id?: string; key: string }[];
}

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

export function sameSession(a: InboxMessageWire, b: InboxMessageWire): boolean {
  if (a.author.kind !== 'agent' || b.author.kind !== 'agent') return false;
  return !!a.author.session && a.author.session === b.author.session && (a.author.host ?? '') === (b.author.host ?? '');
}

export function sendTargetsOf(thread: InboxThread, skip: ReadonlySet<string> = new Set(), wordsAt?: InboxMessageWire): SendTarget[] {
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
    target.message = m;
    groups.set(group, target);
  }
  let targets = [...groups.values()].map((t) => ({
    message: t.message,
    questions: t.questions.map((q) => (q.message_id === t.message.id ? { key: q.key, revision: q.revision } : q)),
    skip: t.skip.map((q) => (q.message_id === t.message.id ? { key: q.key } : q)),
    actions: t.actions.map((a) => (a.message_id === t.message.id ? { key: a.key } : a)),
  }));
  const order = new Map(thread.messages.map((m, index) => [m.id, index]));
  targets.sort((a, b) => (order.get(a.message.id) ?? 0) - (order.get(b.message.id) ?? 0));
  const latest = wordsAt ?? wordsMessage(thread);
  const words = targets.findIndex((t) => t.message.id === latest.id || sameSession(t.message, latest));
  if (words < 0) targets.push({ message: latest, questions: [], skip: [], actions: [] });
  else targets = [...targets.slice(0, words), ...targets.slice(words + 1), targets[words]!];
  return targets;
}

export function tookOverReply(thread: InboxThread): InboxMessageWire | null {
  if (activeHandoff(thread)) return null;
  for (let index = thread.messages.length - 1; index >= 0; index--) {
    const m = thread.messages[index]!;
    if (m.author.kind === 'agent' && !isInboxPermissionSession(m.author.session)) return null;
    if (!m.took_over || !m.to) continue;
    const owner = m.to.session;
    return thread.messages.slice(index + 1).filter((later) => later.to?.session === owner).at(-1) ?? m;
  }
  return null;
}

export function wordsMessage(thread: InboxThread): InboxMessageWire {
  const tookOver = tookOverReply(thread);
  if (tookOver) return tookOver;
  const handoff = activeHandoff(thread);
  if (handoff) {
    const owner = handoff.to!.session;
    const after = thread.messages.slice(thread.messages.indexOf(handoff) + 1).filter((m) => m.author.kind === 'agent' && m.author.session === owner);
    return after.at(-1) ?? handoff;
  }
  // A permission prompt's question (launch, `perm:…`) takes only its own answer: the words go to the agent itself.
  return thread.messages.filter((m) => m.author.kind === 'agent' && !isInboxPermissionSession(m.author.session)).at(-1) ?? thread.messages[0]!;
}

function groupKey(m: InboxMessageWire): string {
  return m.author.kind === 'agent' && m.author.session ? `s:${m.author.host ?? ''}\u0000${m.author.session}` : `m:${m.id}`;
}

export interface SentContents {
  value: string;
  answers: string[];
}

export function sendTargetAnswerIds(target: SendTarget): string[] {
  return [
    ...target.questions.map((q) => `a:${q.message_id ?? target.message.id}/${q.key}`),
    ...target.skip.map((q) => `s:${q.message_id ?? target.message.id}/${q.key}`),
    ...target.actions.map((a) => `x:${a.message_id ?? target.message.id}/${a.key}`),
  ];
}

export function replyKeysToRenew(before: ReadonlyMap<string, SentContents> | null, now: ReadonlyMap<string, SentContents>): string[] {
  if (!before) return [];
  const renew: string[] = [];
  for (const [id, next] of now) {
    const last = before.get(id);
    if (last && (last.value !== next.value || next.answers.some((a) => !last.answers.includes(a)))) renew.push(id);
  }
  return renew;
}
