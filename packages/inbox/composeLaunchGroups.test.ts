/**
 * Remote launch, the folder menu grouped by machine (approval "remote-launch", the picker's A), its rules alone
 * (`launchGroups`, `launchHistory` in compose/model.ts). What can regress: a person with no linked machine seeing a
 * caption or any change at all; the machine used last not on top; a project on two machines listed once; an asleep
 * machine's projects gone; a machine where the agent can't start offering projects that would fail; the default
 * start picking another machine's folder at the same path as the project the person is looking at.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxComposeLaunch } from '@plannotator/core/inbox-types';
import { defaultStartProject, launchGroups, launchHistory, type LaunchMachine, type MachineLaunchRead } from './compose/model';

const SELF = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const MINI = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAW';
const STUDIO = 'ibx_01ARZ3NDEKTSV4RRFFQ69G5FAX';

const AGENTS: InboxComposeLaunch['agents'] = [{ agent: 'claude-code', name: 'Claude Code' }];
const here: InboxComposeLaunch = {
  agents: AGENTS,
  projects: [
    { id: 'prj_web', name: 'web-app', root: '/Users/me/code/web-app', exists: true },
    { id: 'prj_bill_a', name: 'billing-svc', root: '/Users/me/code/billing-svc', exists: true },
  ],
  scratch: { root: '/Users/me/scratch' },
};
const mini: InboxComposeLaunch = {
  agents: AGENTS,
  projects: [
    { id: 'prj_infra', name: 'infra', root: '/Users/me/code/infra', exists: true },
    { id: 'prj_bill_m', name: 'billing-svc', root: '/Users/me/code/billing-svc', exists: true },
  ],
  scratch: { root: '/Users/me/scratch' },
};

const machine = (id: string, name: string, over: Partial<LaunchMachine> = {}): LaunchMachine => ({ id, name, self: false, state: 'online', since: '2026-11-06T09:00:00.000Z', launch: true, ...over });
const SELF_VIEW = machine(SELF, 'MacBook', { self: true, launch: null });
const reads = (entries: [string, InboxComposeLaunch | undefined][]): Map<string, MachineLaunchRead> => new Map(entries.map(([id, launch]) => [id, { launch, home: '/Users/me' }]));
const self = { launch: here, home: '/Users/me', id: SELF, name: 'MacBook' };
const names = (out: ReturnType<typeof launchGroups>) => out.groups.map((g) => g.name);

describe('no linked machine: the menu is exactly what it was', () => {
  test('one group, not grouped, its projects as this computer lists them, no "used last" mark', () => {
    const history = new Map([[SELF, { at: '2026-11-06T10:00:00.000Z', project: 'prj_bill_a' }]]);
    const out = launchGroups({ agent: 'claude-code', self, machines: [SELF_VIEW], reads: new Map(), history });
    expect(out.grouped).toBe(false);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]!.projects.map((p) => p.id)).toEqual(['prj_web', 'prj_bill_a']);
    expect(out.groups[0]!.last).toBeNull();
    expect(out.groups[0]!.projects.every((p) => !('machine' in p))).toBe(true);
  });

  test('a linked machine not read yet (or with nothing for this agent) changes nothing', () => {
    const notRead = launchGroups({ agent: 'claude-code', self, machines: [SELF_VIEW, machine(MINI, 'Mac mini')], reads: new Map() });
    expect(notRead.grouped).toBe(false);
    const noHost = launchGroups({ agent: 'claude-code', self, machines: [SELF_VIEW, machine(MINI, 'Mac mini')], reads: reads([[MINI, { agents: [], projects: mini.projects }]]) });
    expect(noHost.grouped).toBe(false);
  });
});

describe('linked machines: one group per machine', () => {
  test('this computer first when nobody started an agent yet; captions say "this computer" and "asleep"', () => {
    const out = launchGroups({ agent: 'claude-code', self, machines: [SELF_VIEW, machine(MINI, 'Mac mini', { state: 'offline' })], reads: reads([[MINI, mini]]) });
    expect(out.grouped).toBe(true);
    expect(names(out)).toEqual(['MacBook', 'Mac mini']);
    expect(out.groups.map((g) => g.quiet)).toEqual(['this computer', 'asleep']);
    // The asleep machine's last good read still lists its projects, each naming its machine.
    expect(out.groups[1]!.asleep).toBe(true);
    expect(out.groups[1]!.projects.map((p) => [p.id, p.machine, p.machine_name])).toEqual([
      ['prj_infra', MINI, 'Mac mini'],
      ['prj_bill_m', MINI, 'Mac mini'],
    ]);
    expect(out.groups[1]!.scratch).toEqual({ root: '/Users/me/scratch' });
  });

  test('the machine the person started an agent on last is on top, and its last project leads its group', () => {
    const history = new Map([
      [SELF, { at: '2026-11-06T09:00:00.000Z', project: 'prj_web' }],
      [MINI, { at: '2026-11-06T11:00:00.000Z', project: 'prj_bill_m' }],
    ]);
    const out = launchGroups({ agent: 'claude-code', self, machines: [SELF_VIEW, machine(MINI, 'Mac mini'), machine(STUDIO, 'Studio')], reads: reads([[MINI, mini], [STUDIO, here]]), history });
    expect(names(out)).toEqual(['Mac mini', 'MacBook', 'Studio']);
    expect(out.groups[0]!.projects[0]!.id).toBe('prj_bill_m');
    expect(out.groups[0]!.last).toBe('prj_bill_m');
    expect(out.groups[1]!.last).toBe('prj_web');
    expect(out.groups[2]!.last).toBeNull();
  });

  test('a project on two machines shows under each', () => {
    const out = launchGroups({ agent: 'claude-code', self, machines: [SELF_VIEW, machine(MINI, 'Mac mini')], reads: reads([[MINI, mini]]) });
    const billing = out.groups.flatMap((g) => g.projects.filter((p) => p.name === 'billing-svc').map(() => g.name));
    expect(billing).toEqual(['MacBook', 'Mac mini']);
  });

  test('a machine where the agent is not ready shows one line in its words, and none of its projects', () => {
    const signedOut: InboxComposeLaunch = { agents: [], projects: mini.projects, not_ready: [{ agent: 'claude-code', name: 'Claude Code', code: 'signed_out', over_ssh: true }] };
    const pluginOff: InboxComposeLaunch = { agents: [], projects: mini.projects, not_ready: [{ agent: 'claude-code', name: 'Claude Code', code: 'plugin_off' }] };
    const out = launchGroups({ agent: 'claude-code', self, machines: [SELF_VIEW, machine(MINI, 'Mac mini'), machine(STUDIO, 'Studio')], reads: reads([[MINI, signedOut], [STUDIO, pluginOff]]) });
    expect(out.grouped).toBe(true);
    expect(out.groups[1]!.notice).toEqual({ line: "Claude Code isn't signed in on Mac mini", command: null });
    expect(out.groups[1]!.projects).toEqual([]);
    expect(out.groups[1]!.scratch).toBeNull();
    expect(out.groups[2]!.notice?.line).toContain('Studio');
    expect(out.groups[2]!.notice?.command).toContain('claude plugin install');
  });

  test('launch off there, or an older Plannotator there, says so without reading it', () => {
    const out = launchGroups({ agent: 'claude-code', self, machines: [SELF_VIEW, machine(MINI, 'Mac mini', { launch: false }), machine(STUDIO, 'Studio', { launch: null })], reads: new Map() });
    expect(out.groups.map((g) => g.notice?.line ?? null)).toEqual([null, 'Starting agents is off on Mac mini', 'Update Plannotator on Studio to start agents there']);
  });

  test('an unlinked (revoked) machine is gone', () => {
    const out = launchGroups({ agent: 'claude-code', self, machines: [SELF_VIEW, machine(MINI, 'Mac mini', { state: 'revoked' })], reads: reads([[MINI, mini]]) });
    expect(out.grouped).toBe(false);
  });
});

describe('launchHistory: from the merged list', () => {
  test("each machine's newest launched row (a row with `run`, even null); other rows never count", () => {
    const rows = [
      { machine: SELF, project: { id: 'prj_web' }, created_at: '2026-11-06T09:00:00.000Z', run: null },
      { machine: SELF, project: { id: 'prj_bill_a' }, created_at: '2026-11-06T12:00:00.000Z' },
      { machine: MINI, project: { id: 'prj_infra' }, created_at: '2026-11-06T08:00:00.000Z', run: 'working' },
      { machine: MINI, project: { id: 'prj_bill_m' }, created_at: '2026-11-06T10:00:00.000Z', run: null },
      { project: { id: 'prj_x' }, created_at: '2026-11-06T13:00:00.000Z', run: null },
    ];
    expect([...launchHistory(rows)]).toEqual([
      [SELF, { at: '2026-11-06T09:00:00.000Z', project: 'prj_web' }],
      [MINI, { at: '2026-11-06T10:00:00.000Z', project: 'prj_bill_m' }],
    ]);
  });
});

test('the default start: the project the person is looking at by its id, before another machine\'s folder at the same path', () => {
  const merged = { agents: AGENTS, projects: [{ ...mini.projects[1]!, machine: MINI }, ...here.projects] };
  expect(defaultStartProject(merged, { id: 'prj_bill_a', root: '/Users/me/code/billing-svc' })?.id).toBe('prj_bill_a');
});
