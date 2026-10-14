/**
 * Compose's rules alone (compose/model.ts). What can regress: To preselecting
 * the wrong session (or one that is not live), the current project not
 * leading the picker, the palette offering an action no words asked for,
 * closing an empty compose asking a question (or a changed one not asking).
 */
import { describe, expect, test } from 'bun:test';
import type { InboxComposeProject } from '@plannotator/core/inbox-types';
import { actionLabel, composeActions, composeGroups, composeTargets, draftChip, filterGroups, isDirty, preselect, statusLine } from './compose/model';

const session = (id: string, host: string, extra: Partial<InboxComposeProject['sessions'][number]> = {}) => ({
  session: id,
  host,
  started_at: '2026-10-14T09:12:00.000Z',
  last_seen_at: '2026-10-14T15:00:00.000Z',
  busy: false,
  idle_since: '2026-10-14T14:00:00.000Z',
  last_thread: null,
  ...extra,
});

const PROJECTS: InboxComposeProject[] = [
  { project: { id: 'prj_w', name: 'workspaces', root: '/src/workspaces' }, sessions: [session('ses-oc', 'opencode', { busy: true })] },
  { project: { id: 'prj_p', name: 'plannotator', root: '/src/plannotator' }, sessions: [session('ses-cc1', 'claude-code'), session('ses-pi', 'pi')] },
  { project: { id: null, name: 'billing', root: '/src/billing' }, sessions: [session('ses-pi2', 'pi')] },
];

describe('To', () => {
  test('preselects the last session sent to while it is live, else the current project\'s most active, else the most active anywhere; nothing when none is live', () => {
    const current = { id: 'prj_p', root: '/src/plannotator' };
    expect(preselect(PROJECTS, { last: 'ses-pi2', current })?.session).toBe('ses-pi2');
    expect(preselect(PROJECTS, { last: 'ses-gone', current })?.session).toBe('ses-cc1');
    expect(preselect(PROJECTS, { last: null, current: null })?.session).toBe('ses-oc');
    expect(preselect([], { last: 'ses-pi', current })).toBeNull();
  });

  test('the picker puts the current project first, marked; the filter matches host, project and last subject', () => {
    const groups = composeGroups(PROJECTS, { id: null, root: '/src/billing' });
    expect(groups.map((g) => [g.project.name, g.current])).toEqual([
      ['billing', true],
      ['workspaces', false],
      ['plannotator', false],
    ]);
    expect(filterGroups(groups, 'pi plan').flatMap((g) => g.sessions.map((s) => s.session))).toEqual(['ses-pi']);
    const withSubject = composeGroups([{ ...PROJECTS[1]!, sessions: [session('ses-x', 'claude-code', { last_thread: { id: 'msg_1', subject: 'Relay rate limit', at: '2026-10-14T14:50:00.000Z' } })] }], null);
    expect(filterGroups(withSubject, 'rate').length).toBe(1);
    expect(filterGroups(groups, 'nothing-like-this')).toEqual([]);
  });

  test('the status line says who takes it, or why nothing can be sent', () => {
    const [oc] = composeTargets(PROJECTS);
    expect(statusLine({ target: oc!, anyLive: true, ended: null, projectName: null })).toBe('OpenCode is working; it takes this when its turn ends.');
    expect(statusLine({ target: composeTargets(PROJECTS)[1]!, anyLive: true, ended: null, projectName: null })).toBe('Claude Code takes it as its next turn.');
    expect(statusLine({ target: null, anyLive: true, ended: null, projectName: 'ledger' })).toBe('Choose an agent to send it.');
    expect(statusLine({ target: null, anyLive: false, ended: null, projectName: 'ledger' })).toBe('No agent is running in ledger.');
    expect(statusLine({ target: null, anyLive: true, ended: { host: 'pi', session: 's', project_root: null, project_name: null, started_at: null }, projectName: null })).toBe('That session has ended.');
  });
});

describe('closing', () => {
  test('an empty new message closes without asking; words or files ask; a saved draft asks only when something changed', () => {
    const empty = { body: '', session: null, files: [] };
    expect(isDirty({ body: '  ', session: 'ses-pi', files: [] }, empty, false)).toBe(false);
    expect(isDirty({ body: 'An idea', session: null, files: [] }, empty, false)).toBe(true);
    expect(isDirty({ body: '', session: null, files: ['upl_1'] }, empty, false)).toBe(true);
    const saved = { body: 'An idea', session: 'ses-pi', files: ['upl_1'] };
    expect(isDirty({ ...saved }, saved, true)).toBe(false);
    expect(isDirty({ ...saved, session: 'ses-cc1' }, saved, true)).toBe(true);
    expect(isDirty({ ...saved, files: [] }, saved, true)).toBe(true);
  });

  test('a draft\'s chip is worded, never colour alone', () => {
    const to = { host: 'claude-code', session: 's', project_root: null, project_name: null, started_at: null };
    expect(draftChip({ to, status: 'live' })).toBe('Claude Code is live');
    expect(draftChip({ to, status: 'ended' })).toBe('That session ended');
    expect(draftChip({ to: null, status: 'none' })).toBe('No agent chosen');
  });
});

describe('the palette\'s Actions', () => {
  const targets = composeTargets(PROJECTS);
  test('an empty query: New message… and the session last sent to while it is live', () => {
    expect(composeActions('', targets, 'ses-pi').map(actionLabel)).toEqual(['New message…', 'Message Pi in plannotator']);
    expect(composeActions('', targets, 'ses-gone').map(actionLabel)).toEqual(['New message…']);
  });

  test('typed words: the action words offer New message…; a host or project names the sessions; other words offer nothing', () => {
    expect(composeActions('new', targets, null).map(actionLabel)).toEqual(['New message…']);
    expect(composeActions('idea', targets, null).map(actionLabel)).toEqual(['New message…']);
    expect(composeActions('pi', targets, null).map(actionLabel)).toEqual(['Message Pi in plannotator', 'Message Pi in billing']);
    expect(composeActions('message billing', targets, null).map(actionLabel)).toEqual(['New message…', 'Message Pi in billing']);
    expect(composeActions('relay timeout', targets, null)).toEqual([]);
  });
});
