/**
 * Tag agents with `@` in a reply or a comment (approval "inbox-tag-agents",
 * Lines variant). Pure: the picker's rows and groups, the readable labels a
 * tag becomes in the text, who a reply goes to and the heads-ups under the
 * field, the per-agent delivery lines, and the overlapping marks. The
 * components draw them (ComposerField, TagNotes, Thread, InboxList).
 *
 * A tag is the session's id (`MentionPerson.id`); its readable token in the
 * text is `@<label>` (ui's mention grammar), so a label must be unique among
 * the rows offered: "Claude Code (another session)" in the thread's project,
 * "Claude Code (plannotator)" in another one, and a number after those when
 * two would still read the same.
 */
import { INBOX_HOST_NAMES, type InboxMessageWire, type InboxParticipant, type InboxTag, type InboxThread } from '@plannotator/core/inbox-types';
import type { MentionPerson } from '@plannotator/ui/utils/mentions';
import type { TagMode, TaggableModel, TaggableSession } from './api';
import { deliveryLine, uncertainItem, waitInputs, type DeliveryLine, type RecipientConnection } from './deliveryLine';

/** The group heading of the agents that read the Inbox only (MCP): never woken. */
export const TAG_READERS_GROUP = 'Reads the Inbox, not woken';

/** One row of the picker: a taggable (or, on an older Plannotator, not yet taggable) session. */
export interface TagOption {
  /** The session id: the mention id and the tag's `session`. */
  id: string;
  host: string | null;
  /** Its readable label: the `@<label>` token and the chip. */
  label: string;
  /** The agent's own name ("Claude Code", "Pi", an MCP agent's name). */
  agent: string;
  /** The picker row's second line: "billing-api · working · since 9:14 AM". */
  detail: string;
  /** The group heading: the agent's name, or TAG_READERS_GROUP. */
  group: string;
  owner: boolean;
  /** Its connection wakes it; false: an MCP agent that sees it when it next reads. */
  wakes: boolean;
  /** False: a live session on an older Plannotator ("Update Plannotator to tag this session"). */
  taggable: boolean;
  /** The project it works in, or null. */
  project: string | null;
}

/** The person's name for an agent: an MCP agent's own name, else its host's, else "An agent". */
export function agentName(host: string | null | undefined, name?: string | null): string {
  if (name) return name;
  if (host) return INBOX_HOST_NAMES[host] ?? host;
  return 'An agent';
}

function stateWords(session: TaggableSession, time: (iso: string) => string): string {
  const parts: string[] = [];
  if (session.project) parts.push(session.project.name);
  if (session.kind === 'mcp') {
    parts.push(session.wrote_thread ? `wrote here at ${time(session.last_at)}` : `seen ${time(session.last_at)}`);
    return parts.join(' · ');
  }
  if (session.busy === true) parts.push('working');
  else if (session.busy === false) parts.push('idle');
  if (session.started_at) parts.push(`since ${time(session.started_at)}`);
  return parts.join(' · ');
}

/**
 * The picker's rows from the taggable model: the owner first, then live
 * sessions grouped by agent (the owner's agent first), then the agents that
 * read the Inbox only. `ownerSession` is the session the reply goes to anyway
 * (the window's own answer, else the server's).
 */
export function tagOptions(model: TaggableModel | null, ownerSession: string | null, threadProjectId: string | null, time: (iso: string) => string): TagOption[] {
  if (!model || !Array.isArray(model.sessions)) return [];
  const owner = ownerSession ?? model.owner?.session ?? null;
  const live = model.sessions.filter((s) => s.kind === 'live');
  const readers = model.sessions.filter((s) => s.kind === 'mcp');
  const ownerRow = model.sessions.find((s) => s.session === owner) ?? null;
  // Agent groups in order: the owner's first, then as they come.
  const order: string[] = [];
  const groupOf = (s: TaggableSession) => (s.kind === 'mcp' ? TAG_READERS_GROUP : agentName(s.host));
  if (ownerRow && ownerRow.kind === 'live') order.push(groupOf(ownerRow));
  for (const s of live) if (!order.includes(groupOf(s))) order.push(groupOf(s));
  const sorted = [
    ...order.flatMap((group) => live.filter((s) => groupOf(s) === group).sort((a, b) => Number(b.session === owner) - Number(a.session === owner))),
    ...readers.sort((a, b) => Number(b.session === owner) - Number(a.session === owner)),
  ];
  const used = new Map<string, number>();
  return sorted.map((s) => {
    const agent = agentName(s.host, s.kind === 'mcp' ? s.name : null);
    // Only rows that can be tagged collide in the text: a session on an older Plannotator never makes Pi read "Pi (infra)".
    const sameAgent = sorted.filter((o) => (o.taggable || o === s) && agentName(o.host, o.kind === 'mcp' ? o.name : null) === agent);
    let label = agent;
    if (s.session !== owner && sameAgent.length > 1) {
      const here = !s.project || s.project.id === threadProjectId;
      label = here ? `${agent} (another session)` : `${agent} (${s.project!.name})`;
    }
    // Two that would still read the same (two Pi sessions in infra): the later ones say "another session".
    const seen = used.get(label) ?? 0;
    used.set(label, seen + 1);
    if (seen > 0) {
      const inner = label.endsWith(')') ? label.slice(label.lastIndexOf('(') + 1, -1) : null;
      label = inner === null ? `${agent} (another session)` : inner === 'another session' ? `${agent} (another session ${seen + 1})` : `${agent} (${inner}, another session)`;
    }
    return {
      id: s.session,
      host: s.host,
      label,
      agent,
      detail: stateWords(s, time),
      group: groupOf(s),
      owner: s.session === owner,
      wakes: s.kind === 'live',
      taggable: s.taggable,
      project: s.project?.name ?? null,
    };
  });
}

/** The rows as ui's mention people: agents, grouped; an older Plannotator's row cannot be picked (`canOpen: false`). */
export function tagPeople(options: readonly TagOption[]): MentionPerson[] {
  return options.map((o) => ({ id: o.id, kind: 'agent' as const, label: o.label, detail: o.taggable ? o.detail : TAG_UPDATE_WORDS, group: o.group, canOpen: o.taggable }));
}

/**
 * The sessions a set of mention ids tags, leaving out the owner (it gets the reply anyway), in the order given.
 * `modes`: the reply box line's choice for a session (absent: an Ask, sent without a mode as before).
 */
export function tagsToSend(ids: readonly string[], options: readonly TagOption[], ownerSession: string | null, modes: ReadonlyMap<string, TagMode> = new Map()): TagToSend[] {
  const out: TagToSend[] = [];
  for (const id of ids) {
    if (id === ownerSession || out.some((t) => t.session === id)) continue;
    const option = options.find((o) => o.id === id);
    const mode = modes.get(id);
    out.push({ ...(option ? { host: option.host, session: id, label: option.label } : { session: id }), ...(mode && mode !== 'ask' ? { mode } : {}) });
  }
  return out;
}

/** One tag as the reply route takes it. */
export interface TagToSend {
  host?: string | null;
  session: string;
  label?: string;
  /** Add or Hand off (the reply box's line); absent: an Ask. */
  mode?: TagMode;
}

/**
 * The one line under the reply box once it tags agents that do not own the
 * thread (approval "inbox-tag-handoff", A2): what Send does with them, and
 * the links that switch it. "Asks Claude Code (herdr) · Add instead · Hand
 * off instead"; "Adds Pi to this thread · Ask instead"; "Hands this thread
 * to Claude Code (herdr) · Ask instead". Add and Hand off are offered only
 * when every agent tagged is woken (a live session); Hand off only for one.
 * A mode that is no longer offered reads as an Ask (`mode`).
 */
export interface TagModeLine {
  mode: TagMode;
  lead: string;
  names: string;
  after: string;
  links: { mode: TagMode; label: string }[];
}

export function tagModeLine(tagged: readonly TagOption[], chosen: TagMode): TagModeLine | null {
  const others = tagged.filter((t) => !t.owner);
  if (others.length === 0) return null;
  const names = namesList(others.map((t) => t.label));
  const canAdd = others.every((t) => t.wakes && t.taggable);
  const canHandOff = canAdd && others.length === 1;
  const mode = effectiveTagMode(tagged, chosen);
  if (mode === 'add') return { mode, lead: 'Adds', names, after: ' to this thread', links: [{ mode: 'ask', label: 'Ask instead' }] };
  if (mode === 'handoff') return { mode, lead: 'Hands this thread to', names, after: '', links: [{ mode: 'ask', label: 'Ask instead' }] };
  const asleep = others.filter((t) => !t.wakes);
  const after =
    asleep.length === 0
      ? ''
      : ` · ${namesList(asleep.map((t) => t.label))} ${asleep.length === 1 ? "isn't" : "aren't"} woken: ${asleep.length === 1 ? 'it sees' : 'they see'} your reply the next time ${asleep.length === 1 ? 'it reads' : 'they read'} this thread`;
  return {
    mode,
    lead: 'Asks',
    names,
    after,
    links: [...(canAdd ? [{ mode: 'add' as const, label: 'Add instead' }] : []), ...(canHandOff ? [{ mode: 'handoff' as const, label: 'Hand off instead' }] : [])],
  };
}

/** The mode a Send uses: the one chosen while it is still offered for these tags, else an Ask. */
export function effectiveTagMode(tagged: readonly TagOption[], chosen: TagMode): TagMode {
  const others = tagged.filter((t) => !t.owner);
  if (others.length === 0 || !others.every((t) => t.wakes && t.taggable)) return 'ask';
  if (chosen === 'handoff' && others.length !== 1) return 'ask';
  return chosen;
}

/**
 * The thread's active hand-off (approval "inbox-tag-handoff"): the person's
 * latest reply that handed it to another session and was not taken back.
 * Its `to` owns the thread now. Null: no hand-off.
 */
export function activeHandoff(thread: InboxThread): InboxMessageWire | null {
  for (let index = thread.messages.length - 1; index >= 0; index--) {
    const message = thread.messages[index]!;
    if (message.author.kind === 'person' && message.handoff && !message.handoff.undone_at && message.to) return message;
  }
  return null;
}

/** The name a hand-off's new owner reads by: the label the person picked, else its agent's name. */
export function handoffName(message: InboxMessageWire): string {
  return message.handoff?.label || agentName(message.to?.host ?? null);
}

/** What one heads-up under the field says (the approved words). */
export function tagHeadsUp(option: TagOption, where: 'reply' | 'comment'): string {
  if (!option.wakes) {
    return `${option.label} can't be woken: it reads the Inbox through MCP. It sees your ${where === 'comment' ? 'comment' : 'reply'} the next time it reads this thread.`;
  }
  return where === 'comment'
    ? `${option.label} doesn't own this thread. It gets this comment with your next Send, and a pointer to this thread.`
    : `${option.label} doesn't own this thread. It gets your reply and a pointer to this thread.`;
}

/** What the live region says when a row is picked. */
export function tagPickedWords(option: TagOption): string {
  if (option.owner) return `Tagged ${option.label}. It owns this thread; it gets your reply anyway.`;
  if (!option.wakes) return `Tagged ${option.label}. It can't be woken; it sees your reply the next time it reads this thread.`;
  return `Tagged ${option.label}. It doesn't own this thread; it gets your reply and a pointer to this thread.`;
}

/** The words under a row that cannot be tagged yet. */
export const TAG_UPDATE_WORDS = 'Update Plannotator to tag this session';

/**
 * Who a reply's tags name in the person's view: "Pi", "Claude Code (another
 * session)". The tag's own label is not stored, so it is worked out again from
 * the thread: the same agent as the owner reads "(another session)".
 */
export function tagName(tag: Pick<InboxTag, 'host' | 'name' | 'session' | 'label'>, ownerHost: string | null | undefined, ownerSession?: string | null): string {
  if (tag.label) return tag.label;
  const name = agentName(tag.host, tag.name);
  if (tag.session !== ownerSession && ownerHost && tag.host && agentName(ownerHost) === name) return `${name} (another session)`;
  return name;
}

/** "Pi", "Pi and Codex", "Pi, Codex and OpenCode". */
export function namesList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** One recipient's line under a sent reply (Lines variant). */
export interface RecipientLine {
  session: string;
  host: string | null;
  name: string;
  owner: boolean;
  line: DeliveryLine;
}

/**
 * The line for one tagged session: delivered, queued with its own Send now,
 * sending, or, for an agent that is not woken, saved until it reads the
 * thread (and read, once its own read_thread read it).
 */
export function tagDeliveryLine(
  tag: InboxTag,
  name: string,
  connection: RecipientConnection | null | undefined,
  time: (iso: string) => string,
  /** The reply's id: the server's clock for it on that session ("Undelivered 3 min"). */
  messageId?: string | null,
): DeliveryLine {
  if (!tag.wakes && !tag.delivery && tag.read_at) return { state: 'delivered', text: `${name} read this thread, ${time(tag.read_at)}` };
  // Not woken, or a Codex `codex queue` that ran out of time (it may not have gone): saved for the next read.
  if ((!tag.wakes || (messageId && uncertainItem(connection, messageId))) && !tag.delivery) return { state: 'saved', text: `Saved for ${name}. It sees it the next time it reads this thread.` };
  return deliveryLine({
    name,
    deliveredAt: tag.delivery?.at ?? null,
    time,
    wakes: true,
    sendingNow: !!tag.deliver_now_at,
    connection,
    ...(messageId ? waitInputs(connection, messageId, { ...tag, into_turn: tag.delivery?.into_turn ?? null }) : {}),
  });
}

/** The tags of the person's message the window reads (a wire message may carry them). */
export function messageTags(message: InboxMessageWire): InboxTag[] {
  return message.author.kind === 'person' && Array.isArray(message.tags) ? message.tags : [];
}

/**
 * The agent sessions a thread involves, in order of first appearance (the
 * row's `participants`, worked out the same way for the thread head).
 */
export function threadParticipants(thread: InboxThread): InboxParticipant[] {
  const out: InboxParticipant[] = [];
  const add = (host: string | null, session: string | null | undefined, name?: string | null) => {
    if (!session || out.some((p) => p.session === session)) return;
    out.push({ host, session, ...(name ? { name } : {}) });
  };
  for (const message of thread.messages) {
    if (message.author.kind === 'agent') add(message.author.host ?? null, message.author.session, message.author.name);
    else if (message.started_by_person && message.to) add(message.to.host, message.to.session);
    for (const tag of messageTags(message)) add(tag.host, tag.session, tag.name);
  }
  return out;
}

/**
 * The names of a thread's participants, for the head ("Claude Code and Pi"):
 * each agent once, two sessions of one agent named once.
 */
export function participantsWords(participants: readonly InboxParticipant[]): string {
  const names: string[] = [];
  for (const p of participants) {
    const name = agentName(p.host, p.name);
    if (!names.includes(name)) names.push(name);
  }
  return namesList(names);
}

/**
 * The Sent row's line for a reply that tags agents: "1 of 3 delivered · Pi queued".
 * `recipients` is the row's `sent.recipients`, the owner first.
 */
export function sentRecipientsWords(recipients: readonly { host: string | null; name?: string | null; delivered_at: string | null; wakes: boolean }[]): string {
  const delivered = recipients.filter((r) => r.delivered_at !== null).length;
  const waiting = recipients.filter((r) => r.delivered_at === null);
  const queued = waiting.filter((r) => r.wakes).map((r) => agentName(r.host, r.name));
  const saved = waiting.filter((r) => !r.wakes).map((r) => agentName(r.host, r.name));
  const parts = [`${delivered} of ${recipients.length} delivered`];
  if (queued.length > 0) parts.push(`${namesList(queued)} queued`);
  if (saved.length > 0 && queued.length === 0) parts.push(`${namesList(saved)} not woken`);
  return parts.join(' · ');
}

/**
 * The tags one Send carries, and the reply they ride: every `@` tag in the
 * words and in every comment the Send carries, once each, on the LAST reply
 * only (the one that carries the words). So a tag in a comment on an earlier
 * target's file still sends the whole reply to that agent, and an agent
 * tagged twice (a comment and the words) gets one reply and one wake. The
 * last reply's own owner is never tagged (it is handed the reply anyway).
 */
export function sendTagsByTarget(
  targets: readonly { id: string; owner: string | null }[],
  wordTags: readonly string[],
  commentTags: ReadonlyMap<string, readonly string[]>,
  options: readonly TagOption[],
  /** The reply box line's mode, for the agents tagged in the words (a comment's tag is an Ask). */
  wordMode: TagMode = 'ask',
): Map<string, TagToSend[]> {
  const out = new Map<string, TagToSend[]>();
  for (const t of targets) out.set(t.id, []);
  const last = targets.at(-1);
  if (!last) return out;
  const ids = [...wordTags, ...targets.flatMap((t) => commentTags.get(t.id) ?? [])];
  const modes = new Map(wordMode === 'ask' ? [] : wordTags.map((id) => [id, wordMode] as const));
  out.set(last.id, tagsToSend(ids, options, last.owner, modes));
  return out;
}
