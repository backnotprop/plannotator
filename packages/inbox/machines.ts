/**
 * Linked machines in the window (docs/agent-guides/inbox-machines.md): what
 * the list, the sidebar, a thread and Settings → Machines say about the other
 * machines this Inbox shows. Every Inbox is equal; "this machine" is only the
 * one whose window this is. Nothing here draws anything while no machine is
 * linked: every label, line and filter needs a linked machine. Pure.
 */

import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { shortTime } from './format';
import type { MachineView, OutboxView } from './api';
import { windowProjectNames } from './projectLabels';

export interface MachinesModel {
  /** This Inbox's own id, or null (an Inbox that cannot link). */
  self: string | null;
  /** This machine first, then the linked ones as the server lists them. Empty while none is linked. */
  all: MachineView[];
  /** The linked machines (never this one). */
  linked: MachineView[];
  /** Each linked machine's name, by id: what a row from it carries beside its project. */
  names: ReadonlyMap<string, string>;
  /** Linked machines that cannot show their threads now (asleep, or needing an update): their rows are greyed. */
  away: ReadonlySet<string>;
}

const NONE: MachinesModel = { self: null, all: [], linked: [], names: new Map(), away: new Set() };

/** The model, from the merged list's (or the latest `machines` frame's) machines. No linked machine: the empty model. */
export function machinesModel(machines: readonly MachineView[] | null | undefined): MachinesModel {
  const list = machines ?? [];
  const self = list.find((m) => m.self) ?? null;
  const linked = list.filter((m) => !m.self);
  if (linked.length === 0) return { ...NONE, self: self?.id ?? null };
  return {
    self: self?.id ?? null,
    all: self ? [self, ...linked] : linked,
    linked,
    names: new Map(linked.map((m) => [m.id, m.name])),
    away: new Set(linked.filter(isAway).map((m) => m.id)),
  };
}

/** A machine whose threads cannot open now: asleep (offline), or too old to show them. Connecting is not away yet. */
export function isAway(machine: Pick<MachineView, 'self' | 'state'>): boolean {
  return !machine.self && (machine.state === 'offline' || machine.state === 'needs_update');
}

/** The row's machine when it is another one (null: this machine's own row, or nothing linked). */
export function rowMachine(row: Pick<InboxListRow, 'machine'>, model: MachinesModel): string | null {
  return row.machine && model.names.has(row.machine) ? row.machine : null;
}

/**
 * The line for a machine that cannot show its threads now: "MacBook asleep since 10:42 AM", or what to do when it
 * runs an older Plannotator (rule 22: "update", never "reconnecting"). Null for a machine that is there.
 */
export function awayLine(machine: Pick<MachineView, 'name' | 'state' | 'since' | 'version'>, now: Date = new Date()): string | null {
  if (machine.state === 'offline') return `${machine.name} asleep since ${shortTime(machine.since, now)}`;
  if (machine.state === 'needs_update') return `Update Plannotator on ${machine.name} to see its threads here`;
  return null;
}

/** An away machine's thread that did not open: its line, and (asleep) that it opens once that machine is back. */
export function threadAwayLine(machine: MachineView | undefined, now: Date = new Date()): string | null {
  const line = machine ? awayLine(machine, now) : null;
  if (!line) return null;
  return machine!.state === 'offline' ? `${line}. This thread opens when it is back.` : `${line}.`;
}

/** How Settings → Machines describes a linked machine's state, in its row's second line. */
export function machineStatus(machine: MachineView, now: Date = new Date()): string {
  const version = machine.version ? ` · Plannotator ${machine.version}` : '';
  switch (machine.state) {
    case 'online':
      return `Online${version}`;
    case 'connecting':
      return 'Connecting…';
    case 'offline':
      return `Asleep · last seen ${shortTime(machine.since, now)}${version}`;
    case 'needs_update':
      return `Needs update${machine.version ? ` · runs ${machine.version}` : ''}`;
    case 'revoked':
      return 'Removed on that machine';
  }
}

/**
 * The list a filter shows: one machine's rows (`machine`), and without the rows of machines that are away when
 * the person hid them (`hideAway`). The sections stay, empty ones included, as a project filter leaves them.
 */
export function filterMachineRows(sections: readonly InboxListSection[], model: MachinesModel, machine: string | null, hideAway: boolean): InboxListSection[] {
  if (model.linked.length === 0 || (!machine && !hideAway)) return sections as InboxListSection[];
  const ownerOf = (row: InboxListRow) => row.machine ?? model.self;
  return sections.map((section) => ({
    ...section,
    threads: section.threads.filter((row) => {
      const owner = ownerOf(row);
      if (machine && owner !== machine) return false;
      return !(hideAway && owner && model.away.has(owner));
    }),
  }));
}

/** Rows waiting on the person per machine (the sidebar's Machines counts), as the Projects counts read them. */
export function machineCounts(sections: readonly InboxListSection[], model: MachinesModel): Map<string, number> {
  const counts = new Map<string, number>(model.all.map((m) => [m.id, 0]));
  for (const section of sections) {
    if (section.id !== 'stopped' && section.id !== 'holding' && section.id !== 'waiting') continue;
    for (const row of section.threads) {
      const owner = row.machine ?? model.self;
      if (owner && counts.has(owner)) counts.set(owner, counts.get(owner)! + 1);
    }
  }
  return counts;
}

type NamedProject = { id: string; root: string; name: string; machine?: string };

/**
 * The window's one name per project (`windowProjectNames`), told apart within each machine only: the same folder
 * on two machines is not a clash of names, it is two machines. A project of another machine carries that
 * machine's name the way a clash carries its parent folder ("billing-svc · MacBook"), so a row reads its machine
 * where it reads its project. `label` false (one machine's list is shown): no machine name, as one project's list
 * drops the project.
 */
export function machineProjectNames(
  input: Parameters<typeof windowProjectNames>[0] & { projects: readonly NamedProject[] },
  model: MachinesModel,
  label: boolean,
): Map<string, string> {
  if (model.linked.length === 0) return windowProjectNames(input);
  const groups = new Map<string, NamedProject[]>();
  for (const project of input.projects) {
    const owner = project.machine ?? model.self ?? '';
    groups.set(owner, [...(groups.get(owner) ?? []), project]);
  }
  const out = new Map<string, string>();
  for (const [owner, projects] of groups) {
    const names = windowProjectNames({ ...input, projects });
    const machine = label ? model.names.get(owner) : undefined;
    for (const [id, name] of names) out.set(id, machine ? `${name} · ${machine}` : name);
  }
  return out;
}

/** A held write's thread-scoped id: the message (`messages/<id>/…`) or the thread (`threads/<id>/…`) it is for. */
export function outboxTarget(entry: Pick<OutboxView, 'route'>): { kind: 'message' | 'thread'; id: string } | null {
  const match = /^(messages|threads)\/([^/]+)\//.exec(entry.route);
  return match ? { kind: match[1] === 'messages' ? 'message' : 'thread', id: match[2]! } : null;
}

/** Writes that carry the person's words (a reply, a re-ask, a message to the thread): the ones a thread shows waiting. */
export function outboxCarriesWords(entry: Pick<OutboxView, 'route'>): boolean {
  return /^messages\/[^/]+\/(reply|reask)$/.test(entry.route) || /^threads\/[^/]+\/message$/.test(entry.route);
}

/**
 * What a thread shows of the writes held for its machine, oldest first: the person's words still on their way, and
 * any write of the thread that did not land and was not dismissed. A delivered write shows nothing here: it is in
 * the thread itself.
 */
export function threadOutbox(entries: ReadonlyMap<string, OutboxView>, thread: { thread_id: string; messages: readonly { id: string }[] }): OutboxView[] {
  if (entries.size === 0) return [];
  const ids = new Set([thread.thread_id, ...thread.messages.map((m) => m.id)]);
  return [...entries.values()]
    .filter((entry) => {
      const target = outboxTarget(entry);
      if (entry.thread !== thread.thread_id && (!target || !ids.has(target.id))) return false;
      if (outboxPending(entry)) return outboxCarriesWords(entry);
      return entry.notice !== null && !entry.dismissed;
    })
    .sort((a, b) => a.queued_at.localeCompare(b.queued_at));
}

/** Still on its way: never "delivered" before the other machine's Inbox answered (rule 12). */
export function outboxPending(entry: Pick<OutboxView, 'state'>): boolean {
  return entry.state === 'queued' || entry.state === 'sending';
}

/**
 * What a thread says about a held write: waiting ("Sending to MacBook…", "Will send when MacBook is back"), or
 * why it did not land. Null once it landed (the reply is then in the thread itself).
 */
export function outboxLine(entry: OutboxView, machine: Pick<MachineView, 'name' | 'state'> | null): { tone: 'waiting' | 'failed'; text: string } | null {
  const name = machine?.name ?? 'the other machine';
  if (outboxPending(entry)) {
    // Online or still connecting: on its way. Asleep or out of date: it waits for the machine. Removed there: it
    // cannot go until the link is made again, said so rather than promised.
    if (!machine || machine.state === 'online' || machine.state === 'connecting') return { tone: 'waiting', text: `Sending to ${name}…` };
    if (machine.state === 'revoked') return { tone: 'waiting', text: `Not sent: ${name} removed the link. Link it again to send.` };
    if (machine.state === 'needs_update') return { tone: 'waiting', text: `Will send when ${name} is updated` };
    return { tone: 'waiting', text: `Will send when ${name} is back` };
  }
  if (entry.dismissed || !entry.notice) return null;
  switch (entry.notice.kind) {
    case 'refused': {
      const why = entry.answer && typeof entry.answer === 'object' ? (entry.answer as { error?: unknown }).error : null;
      return { tone: 'failed', text: `Not delivered: ${typeof why === 'string' && why ? why.replace(/\.$/, '') : `${name} refused it`}.` };
    }
    case 'not_delivered':
      return { tone: 'failed', text: `Not delivered: ${name} was unlinked before it went.` };
    case 'may_have_been_delivered':
      return { tone: 'failed', text: `May have been delivered. Check on ${name}.` };
  }
}
