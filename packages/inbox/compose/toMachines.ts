/**
 * To's machine switch (approval "inbox-launcher-machine-switch"): the pure rules ToPicker and PhoneToSheet share.
 * With two or more machines To opens on one machine at a time: its running agents ("Running", four, then "N more
 * running"), then what can start there ("Start new", one row per agent kind in its default project). Typing looks
 * across every machine. With one machine there is no switch, and with nothing to start (the Board's New card) the
 * list is the running sessions alone, as it always was.
 */
import type { InboxComposeLaunch } from '@plannotator/core/inbox-types';
import { whenTime } from '../format';
import { defaultStartProject, filterGroups, pickerRows, type ComposeGroup, type ComposeStart, type MachineLaunchProject, type PickerRow } from './model';

/** This computer's key in the switch (a linked machine's is its id). */
export const HERE = 'here';

export interface ToMachine {
  /** `HERE`, or the linked machine's id. */
  key: string;
  /** The linked machine's id; null for this computer. */
  machine: string | null;
  name: string;
  self: boolean;
  asleep: boolean;
  /** When it fell asleep (ISO), for "asleep since 9:10 AM". */
  since: string | null;
  /** Its home folder, for `~/…` paths. */
  home: string | null;
  /** Its live sessions, in the picker's order. */
  groups: readonly ComposeGroup[];
  /** What can start there; a linked machine's projects carry `machine` and `machine_name`. Null: nothing starts there from here. */
  launch: { agents: InboxComposeLaunch['agents']; projects: readonly MachineLaunchProject[] } | null;
  /** Why nothing starts there, in the folder menu's words ("Starting agents is off on Atlas"). */
  notice: string | null;
}

export type ToItem =
  | { type: 'cap'; key: string; words: string }
  | { type: 'head'; key: string; machine: ToMachine }
  | { type: 'session'; key: string; row: PickerRow; machine: ToMachine }
  | { type: 'more'; key: string; machine: ToMachine; count: number }
  | { type: 'start'; key: string; start: ComposeStart; machine: ToMachine }
  | { type: 'missing'; key: string; agent: string; name: string; machine: ToMachine }
  | { type: 'notice'; key: string; words: string };

/** The items ↓ ↑ and Enter walk: a running agent that can take a message now, a start row, "N more running". */
export const pickable = (item: ToItem): boolean => (item.type === 'session' && !item.machine.asleep) || item.type === 'start' || item.type === 'more';

/** Whether a row is the one To names: a session by its id; a start row by its key, or (browsing) by its machine and agent, whatever folder To moved it to. */
export function toItemOn(item: ToItem, selected: string | null, typing: boolean): boolean {
  if (!selected) return false;
  if (item.type === 'session') return item.key === selected;
  if (item.type !== 'start') return false;
  return item.key === selected || (!typing && selected.startsWith(`start:${item.machine.key}:${item.start.agent}:`));
}

/** Running agents a machine shows before "N more running". */
export const RUNNING_SHOWN = 4;

export const liveCount = (m: ToMachine): number => m.groups.reduce((n, g) => n + g.sessions.length, 0);

/** A start row's key: the machine, the agent and the project, so a search's rows for two projects stay apart. */
export const toStartKey = (machine: string | null, agent: string, project: string): string => `start:${machine ?? HERE}:${agent}:${project}`;

/** "Atlas asleep since 9:10 AM" and the "N more" list's "asleep since 9:10 AM". */
export const asleepSince = (m: Pick<ToMachine, 'since'>): string => (m.since ? `asleep since ${whenTime(m.since)}` : 'asleep');

/** What the "N more" list says under a machine's name. */
export function machineSub(m: ToMachine): string {
  if (m.asleep) return asleepSince(m);
  const n = liveCount(m);
  return n ? `${n} running` : 'Nothing running';
}

/** Every agent kind any machine can start, first seen first: a machine without one shows it as "Not on <machine>". */
export function toKinds(machines: readonly ToMachine[]): { agent: string; name: string }[] {
  const out: { agent: string; name: string }[] = [];
  for (const m of machines) for (const a of m.launch?.agents ?? []) if (!out.some((k) => k.agent === a.agent)) out.push({ agent: a.agent, name: a.name });
  return out;
}

/** The machine To opens on: the one the current pick is on, else this computer. */
export function openingMachine(machines: readonly ToMachine[], pickedOn: string | null): string {
  return machines.find((m) => m.key === pickedOn)?.key ?? machines[0]?.key ?? HERE;
}

const words = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean);

function startRow(m: ToMachine, agent: { agent: string; name: string }, project: MachineLaunchProject): ToItem {
  return { type: 'start', key: toStartKey(m.machine, agent.agent, project.id), start: { agent: agent.agent as ComposeStart['agent'], name: agent.name, project }, machine: m };
}

/** One machine's start rows, browsing: each kind in the machine's default project, a kind it lacks as "Not on <machine>". */
function startRows(m: ToMachine, kinds: readonly { agent: string; name: string }[], current: { id: string | null; root: string | null } | null): ToItem[] {
  const launch = m.launch;
  if (!launch || launch.agents.length === 0) return [];
  // A linked machine's projects are its own: the project this window looks at is never one of them.
  const project = defaultStartProject(launch as InboxComposeLaunch, m.self ? current : null) as MachineLaunchProject | null;
  if (!project) return [];
  return kinds.map((k) =>
    launch.agents.some((a) => a.agent === k.agent) ? startRow(m, k, project) : { type: 'missing' as const, key: `missing:${m.key}:${k.agent}`, agent: k.agent, name: k.name, machine: m },
  );
}

/**
 * One machine's start rows that match the typed words: a word naming the agent (or the machine, or "start new") offers
 * its default project; other words pick each project whose name or folder they match ("tidepool": every kind in tidepool).
 */
function startHits(m: ToMachine, kinds: readonly { agent: string; name: string }[], typed: string[], many: boolean, current: { id: string | null; root: string | null } | null): ToItem[] {
  const launch = m.launch;
  if (!launch || launch.agents.length === 0) return [];
  const hit = (...parts: string[]) => {
    const hay = parts.join(' ').toLowerCase();
    return typed.every((w) => hay.includes(w));
  };
  const machineWords = many ? m.name : '';
  const fallback = defaultStartProject(launch as InboxComposeLaunch, m.self ? current : null) as MachineLaunchProject | null;
  const out: ToItem[] = [];
  for (const k of kinds) {
    if (!launch.agents.some((a) => a.agent === k.agent)) {
      if (many && hit(k.name, machineWords)) out.push({ type: 'missing', key: `missing:${m.key}:${k.agent}`, agent: k.agent, name: k.name, machine: m });
      continue;
    }
    if (fallback && hit(k.name, machineWords, 'start new')) {
      out.push(startRow(m, k, fallback));
      continue;
    }
    for (const p of launch.projects) if (hit(k.name, machineWords, p.name, p.root, 'start new')) out.push(startRow(m, k, p));
  }
  return out;
}

/** Whether a machine has a "Start new" part: something starts there, or a line says why nothing does. */
const startsThere = (m: ToMachine) => (!!m.launch && m.launch.agents.length > 0) || !!m.notice;

/** The list comes in parts ("Running", "Start new"): there is a switch, or something to start. Otherwise the plain list of sessions. */
export const inParts = (machines: readonly ToMachine[]): boolean => machines.length > 1 || machines.some(startsThere);

/**
 * The list under the switch. Browsing: the chosen machine alone. Typing: every machine with a match, each under its
 * name when there are several. Empty while typing: nothing matches (the picker says so).
 */
export function toItems(input: {
  machines: readonly ToMachine[];
  chosen: string;
  query: string;
  /** Machines whose "N more running" was pressed. */
  expanded: ReadonlySet<string>;
  current: { id: string | null; root: string | null } | null;
}): ToItem[] {
  const { machines, query, expanded, current } = input;
  const many = machines.length > 1;
  const parts = inParts(machines);
  const kinds = toKinds(machines);
  const typed = words(query);
  if (typed.length > 0) {
    const out: ToItem[] = [];
    for (const m of machines) {
      const shown = filterGroups(m.groups, query, many ? m.name : '');
      const rows = pickerRows(shown, m.groups);
      const starts = startHits(m, kinds, typed, many, current);
      if (rows.length === 0 && starts.length === 0) continue;
      if (many) out.push({ type: 'head', key: `head:${m.key}`, machine: m });
      if (rows.length) {
        if (parts) out.push({ type: 'cap', key: `cap:run:${m.key}`, words: 'Running' });
        for (const row of rows) out.push({ type: 'session', key: row.target.session, row, machine: m });
      }
      if (starts.length) {
        out.push({ type: 'cap', key: `cap:start:${m.key}`, words: 'Start new' });
        out.push(...starts);
      }
    }
    return out;
  }
  const m = machines.find((x) => x.key === input.chosen) ?? machines[0];
  if (!m) return [];
  const rows = pickerRows(m.groups);
  // Sessions only, one machine (the Board's New card, or starting agents off): the plain list, as it always was.
  if (!parts) return rows.map((row) => ({ type: 'session' as const, key: row.target.session, row, machine: m }));
  const out: ToItem[] = [];
  if (m.asleep) out.push({ type: 'cap', key: `cap:asleep:${m.key}`, words: `${m.name} ${asleepSince(m)}` });
  else if (rows.length === 0) out.push({ type: 'cap', key: `cap:none:${m.key}`, words: 'Nothing running' });
  if (rows.length) {
    out.push({ type: 'cap', key: `cap:run:${m.key}`, words: 'Running' });
    const open = expanded.has(m.key);
    for (const row of open ? rows : rows.slice(0, RUNNING_SHOWN)) out.push({ type: 'session', key: row.target.session, row, machine: m });
    if (!open && rows.length > RUNNING_SHOWN) out.push({ type: 'more', key: `more:${m.key}`, machine: m, count: rows.length - RUNNING_SHOWN });
  }
  if (startsThere(m)) {
    out.push({ type: 'cap', key: `cap:start:${m.key}`, words: 'Start new' });
    if (m.notice) out.push({ type: 'notice', key: `notice:${m.key}`, words: m.notice });
    else out.push(...startRows(m, kinds, current));
  }
  return out;
}

/** Below this a machine's button is too narrow to read: the switch keeps fewer and puts the rest under "N more". */
export const SWITCH_MIN_BUTTON = 150;

/**
 * Which machines keep their own button on a computer, from the buttons' natural widths and the room the switch has.
 * All of them when they fit as they are; all of them squeezed to equal widths while each keeps `SWITCH_MIN_BUTTON`;
 * else as many as keep it, beside "N more", always this computer (the first) and the chosen one.
 */
export function fitMachineSwitch(input: { keys: readonly string[]; widths: readonly number[]; avail: number; moreWidth: number; chosen: string }): { shown: string[]; rest: string[]; squeeze: boolean } {
  const { keys, widths, avail, moreWidth, chosen } = input;
  const natural = widths.reduce((a, w) => a + w, 0);
  if (natural <= avail || keys.length < 2) return { shown: [...keys], rest: [], squeeze: false };
  if (avail / keys.length >= SWITCH_MIN_BUTTON) return { shown: [...keys], rest: [], squeeze: true };
  const k = Math.max(2, Math.floor((avail - moreWidth) / SWITCH_MIN_BUTTON));
  const first = keys[0]!;
  const keep = new Set([first, ...(chosen !== first && keys.includes(chosen) ? [chosen] : []), ...keys.filter((key) => key !== first && key !== chosen)].slice(0, k));
  return { shown: keys.filter((key) => keep.has(key)), rest: keys.filter((key) => !keep.has(key)), squeeze: true };
}
