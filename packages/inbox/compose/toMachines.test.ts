/**
 * To's machine switch (approval "inbox-launcher-machine-switch"), the pure rules: what the list under the switch
 * holds for the chosen machine, what typing finds across machines, and which machines keep a button when there are
 * more than fit. The failures this catches: another machine's agents or start rows leaking into the chosen one's list,
 * a list that runs away with agents, an asleep machine's agent offered as if it could take a message, the Board's plain
 * list growing captions, and the switch dropping this computer or the chosen machine under "N more".
 */
import { describe, expect, test } from 'bun:test';
import type { InboxComposeSession } from '@plannotator/core/inbox-types';
import { composeGroups, type MachineLaunchProject } from './model';
import { fitMachineSwitch, HERE, liveCount, machineSub, pickable, toItemOn, toItems, toStartKey, type ToItem, type ToMachine } from './toMachines';

const ATLAS = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAW';
const CLAUDE = { agent: 'claude-code' as const, name: 'Claude Code' };
const CODEX = { agent: 'codex' as const, name: 'Codex' };
const PI = { agent: 'pi' as const, name: 'Pi' };

let n = 0;
function session(host: string, label: string, busy = false): InboxComposeSession {
  n += 1;
  return { host, session: `ses_${n}`, started_at: '2026-11-12T17:00:00.000Z', label, busy } as unknown as InboxComposeSession;
}
const project = (id: string, name: string, root: string) => ({ id, name, root, exists: true });
function groupsOf(...entries: { id: string; name: string; root: string; sessions: InboxComposeSession[] }[]) {
  return composeGroups(entries.map((e) => ({ project: { id: e.id, name: e.name, root: e.root }, sessions: e.sessions })) as never, null);
}

function lumen(over: Partial<ToMachine> = {}): ToMachine {
  return {
    key: HERE,
    machine: null,
    name: 'Lumen',
    self: true,
    asleep: false,
    since: null,
    home: '/Users/me',
    groups: groupsOf({ id: 'prj_lw', name: 'lantern-web', root: '/Users/me/lantern-web', sessions: [session('claude-code', 'Colour tokens', true), session('codex', 'Docs pass')] }),
    launch: { agents: [CLAUDE, CODEX, PI], projects: [project('prj_lw', 'lantern-web', '/Users/me/lantern-web'), project('prj_ha', 'harbor-api', '/Users/me/harbor-api')] },
    notice: null,
    ...over,
  };
}
const on = (p: ReturnType<typeof project>): MachineLaunchProject => ({ ...p, machine: ATLAS, machine_name: 'Atlas' });
function atlas(over: Partial<ToMachine> = {}): ToMachine {
  return {
    key: ATLAS,
    machine: ATLAS,
    name: 'Atlas',
    self: false,
    asleep: false,
    since: '2026-11-12T14:10:00.000Z',
    home: '/Users/atlas',
    groups: groupsOf(
      { id: 'prj_kr', name: 'kiln-render', root: '/Users/atlas/kiln-render', sessions: [session('claude-code', 'Staging certs', true)] },
      { id: 'prj_tp', name: 'tidepool', root: '/Users/atlas/tidepool', sessions: [session('pi', 'Render queue')] },
    ),
    launch: { agents: [CLAUDE, PI], projects: [on(project('prj_kr', 'kiln-render', '/Users/atlas/kiln-render')), on(project('prj_tp', 'tidepool', '/Users/atlas/tidepool'))] },
    notice: null,
    ...over,
  };
}

const browse = (machines: ToMachine[], chosen = HERE, expanded: string[] = []) => toItems({ machines, chosen, query: '', expanded: new Set(expanded), current: null });
const typed = (machines: ToMachine[], query: string) => toItems({ machines, chosen: HERE, query, expanded: new Set(), current: null });
/** The list as words: captions, "agent label", "+ agent in project", "agent: Not on …", "N more running". */
function read(items: ToItem[]): string[] {
  return items.map((item) => {
    if (item.type === 'cap') return `[${item.words}]`;
    if (item.type === 'head') return `# ${item.machine.name}`;
    if (item.type === 'session') return `${item.row.target.host} ${item.row.target.label}`;
    if (item.type === 'start') return `+ ${item.start.name} in ${item.start.project.name}`;
    if (item.type === 'missing') return `${item.name}: Not on ${item.machine.name}`;
    if (item.type === 'more') return `${item.count} more running`;
    return `! ${item.words}`;
  });
}

describe('browsing: one machine at a time', () => {
  test('one machine: Running, then Start new with each agent in the default project; no machine names anywhere', () => {
    expect(read(browse([lumen()]))).toEqual(['[Running]', 'claude-code Colour tokens', 'codex Docs pass', '[Start new]', '+ Claude Code in lantern-web', '+ Codex in lantern-web', '+ Pi in lantern-web']);
    // The project the person is looking at is where a new agent starts.
    const there = toItems({ machines: [lumen()], chosen: HERE, query: '', expanded: new Set(), current: { id: 'prj_ha', root: null } });
    expect(read(there).filter((w) => w.startsWith('+'))).toEqual(['+ Claude Code in harbor-api', '+ Codex in harbor-api', '+ Pi in harbor-api']);
  });

  test('sessions only and one machine (the Board, or starting off): the plain list with no captions, as it always was', () => {
    expect(read(browse([lumen({ launch: null })]))).toEqual(['claude-code Colour tokens', 'codex Docs pass']);
  });

  test("two machines: the chosen machine's agents and starts only, a kind it lacks says so, its starts carry the machine", () => {
    const items = browse([lumen(), atlas()], ATLAS);
    expect(read(items)).toEqual(['[Running]', 'claude-code Staging certs', 'pi Render queue', '[Start new]', '+ Claude Code in kiln-render', 'Codex: Not on Atlas', '+ Pi in kiln-render']);
    const start = items.find((i) => i.type === 'start');
    expect(start?.type === 'start' && (start.start.project as MachineLaunchProject).machine).toBe(ATLAS);
    expect(items.filter(pickable).map((i) => i.type)).toEqual(['session', 'session', 'start', 'start']);
    // This computer's list names none of Atlas's.
    expect(read(browse([lumen(), atlas()], HERE))).not.toContain('claude-code Staging certs');
  });

  test('the count on a button is that machine\'s running agents; the "N more" list says the same in words', () => {
    expect(liveCount(lumen())).toBe(2);
    expect(liveCount(atlas({ groups: [] }))).toBe(0);
    expect(machineSub(atlas())).toBe('2 running');
    expect(machineSub(atlas({ groups: [] }))).toBe('Nothing running');
    expect(machineSub(atlas({ asleep: true }))).toMatch(/^asleep since \d{1,2}:\d{2} [AP]M$/);
  });

  test('more than four running: four, then "N more running", which opens the rest; Start new stays in reach', () => {
    const many = Array.from({ length: 7 }, (_, i) => session('claude-code', `Task ${i + 1}`));
    const busy = lumen({ groups: groupsOf({ id: 'prj_lw', name: 'lantern-web', root: '/Users/me/lantern-web', sessions: many }) });
    const shut = read(browse([busy, atlas()]));
    expect(shut.filter((w) => w.startsWith('claude-code Task'))).toHaveLength(4);
    expect(shut).toContain('3 more running');
    expect(shut.indexOf('[Start new]')).toBe(6);
    const open = read(browse([busy, atlas()], HERE, [HERE]));
    expect(open.filter((w) => w.startsWith('claude-code Task'))).toHaveLength(7);
    expect(open).not.toContain('3 more running');
  });

  test('nothing running there: says so, then its starts', () => {
    expect(read(browse([lumen(), atlas({ groups: [] })], ATLAS))).toEqual(['[Nothing running]', '[Start new]', '+ Claude Code in kiln-render', 'Codex: Not on Atlas', '+ Pi in kiln-render']);
  });

  test("asleep: since when, its agents shown but not offered, its starts still offered (they wait for it)", () => {
    const items = browse([lumen(), atlas({ asleep: true })], ATLAS);
    expect(read(items)[0]).toMatch(/^\[Atlas asleep since \d{1,2}:\d{2} [AP]M\]$/);
    expect(items.filter((i) => i.type === 'session')).toHaveLength(2);
    expect(items.filter(pickable).every((i) => i.type === 'start')).toBe(true);
  });

  test('starting off there: one line in its words, no start rows', () => {
    const items = browse([lumen(), atlas({ launch: null, notice: 'Starting agents is off on Atlas' })], ATLAS);
    expect(read(items).slice(-2)).toEqual(['[Start new]', '! Starting agents is off on Atlas']);
  });

  test("the row To names is checked: a session by its id, a start by machine and agent, whatever folder To moved it to", () => {
    const items = browse([lumen(), atlas()], ATLAS);
    const claude = items.find((i) => i.type === 'start' && i.start.agent === 'claude-code')!;
    expect(toItemOn(claude, toStartKey(ATLAS, 'claude-code', 'prj_tp'), false)).toBe(true);
    expect(toItemOn(claude, toStartKey(null, 'claude-code', 'prj_lw'), false)).toBe(false);
  });
});

describe('typing: every machine', () => {
  test("a project's name finds every machine's agents and starts there, each machine under its name", () => {
    expect(read(typed([lumen(), atlas()], 'tidepool'))).toEqual(['# Atlas', '[Running]', 'pi Render queue', '[Start new]', '+ Claude Code in tidepool', '+ Pi in tidepool']);
  });

  test("a machine's name finds its agents and its default starts; an agent's name narrows to it", () => {
    expect(read(typed([lumen(), atlas()], 'atlas claude'))).toEqual(['# Atlas', '[Running]', 'claude-code Staging certs', '[Start new]', '+ Claude Code in kiln-render']);
    expect(read(typed([lumen(), atlas()], 'codex atlas'))).toEqual(['# Atlas', '[Start new]', 'Codex: Not on Atlas']);
  });

  test('nothing matches: an empty list (the picker says so)', () => {
    expect(typed([lumen(), atlas()], 'zzz')).toEqual([]);
  });
});

describe('the switch on a computer: who keeps a button', () => {
  const keys = [HERE, ATLAS, 'orbit', 'quill', 'fern'];

  test('five short names fit as they are', () => {
    expect(fitMachineSwitch({ keys, widths: [96, 90, 74, 80, 78], avail: 534, moreWidth: 80, chosen: HERE })).toEqual({ shown: keys, rest: [], squeeze: false });
  });

  test('too wide, but each still 150 px or more: all of them, squeezed to equal widths', () => {
    expect(fitMachineSwitch({ keys: keys.slice(0, 3), widths: [190, 190, 190], avail: 534, moreWidth: 80, chosen: HERE })).toEqual({ shown: keys.slice(0, 3), rest: [], squeeze: true });
  });

  test('five long names: this computer and the chosen machine keep buttons, the rest go under "N more"', () => {
    const fit = fitMachineSwitch({ keys, widths: [190, 190, 180, 190, 190], avail: 534, moreWidth: 90, chosen: 'fern' });
    expect(fit.shown).toEqual([HERE, 'fern']);
    expect(fit.rest).toEqual([ATLAS, 'orbit', 'quill']);
    expect(fitMachineSwitch({ keys, widths: [190, 190, 180, 190, 190], avail: 534, moreWidth: 90, chosen: HERE }).shown).toEqual([HERE, ATLAS]);
  });
});
