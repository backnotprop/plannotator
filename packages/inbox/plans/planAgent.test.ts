/**
 * Whom a plan page's Send and Direct Edits go to (`planAgentOf`, planAgent.ts). What regresses if these fail:
 * - a plan written in a git worktree (or a folder whose name plan review lowercases or cuts at 30 characters) says no
 *   agent is running while the agent that wrote it is live: plan review files the plan under the worktree folder's
 *   name, the Inbox files the session under the repository, and the two names never meet;
 * - the words go to another session than the one that wrote the plan: another session of the same repository (its
 *   main checkout or another worktree), a session of another repository whose folder has the same name (or the same
 *   name after the cut), or a session of another host that happens to carry the same id;
 * - with the plan's own session gone, or no session recorded, the page picks an agent it did not pick before (the
 *   project rules are unchanged: one agent matched by the project's id or folder, never one by the folder's name only).
 */
import { expect, test } from 'bun:test';
import type { PlanRecord, PlanVersion } from '@plannotator/core/plans';
import type { ComposeSessionsModel } from '../api';
import { planAgentOf } from './planAgent';

type Live = { session: string; host?: string; root?: string; label?: string };
type Project = { id: string | null; name: string; root: string; sessions: Live[] };

const at = '2026-11-28T10:00:00.000Z';
const model = (projects: Project[]): ComposeSessionsModel => ({
  serverSession: 'srv',
  home: '/Users/charlie',
  projects: projects.map(({ sessions, ...project }) => ({
    project,
    sessions: sessions.map((s) => ({ host: 'claude-code', started_at: at, last_seen_at: at, busy: false, idle_since: null, last_thread: null, ...s })),
  })),
});

/** A plan as the import builds it from plan review's history: the folder's name only, no Inbox project. */
const plan = (project_name: string | null, change: Partial<PlanRecord> = {}) => ({ id: 'pln_01', name: 'Cache keys', project_name, project_id: null, project_root: null, thread_id: null, ...change }) as PlanRecord;
/** Versions as plan review recorded them: `agent` the session that submitted each (`NNN.agent.json`), none before Plans was on. */
const versions = (...agents: ({ session: string; host: string | null } | null)[]) =>
  agents.map((agent, i) => ({ version_number: i + 1, agent_session: agent?.session ?? null, agent_host: agent?.host ?? null, agent_name: null }) as PlanVersion);

const to = (agent: ReturnType<typeof planAgentOf>) => (agent.kind === 'session' ? `${agent.host}:${agent.session}` : agent.kind);

// The Inbox files every worktree of a repository under the repository (packages/server/inbox-project-root.ts, rule 3).
const harbor = (sessions: Live[]): Project => ({ id: 'prj_harbor', name: 'harbor', root: '/Users/charlie/code/harbor', sessions });

test('a plan written in a worktree goes to the session that wrote it, which the Inbox files under the repository', () => {
  // Plan review named the plan after the worktree's folder, lowercased and cut to 30 characters.
  const fromWorktree = plan('harbor-rotate-refresh-tokens-w');
  const wrote = versions({ session: 'c0ffee00-0000-4000-8000-000000000001', host: 'claude-code' });
  expect(to(planAgentOf(fromWorktree, wrote, model([harbor([{ session: 'c0ffee00-0000-4000-8000-000000000001' }])])))).toBe('claude-code:c0ffee00-0000-4000-8000-000000000001');
  // Its newest version wins over an older one by another session, and a version the person made names none.
  const twice = versions({ session: 'sess-old', host: 'claude-code' }, { session: 'c0ffee00-0000-4000-8000-000000000001', host: 'claude-code' }, null);
  expect(to(planAgentOf(fromWorktree, twice, model([harbor([{ session: 'sess-old' }, { session: 'c0ffee00-0000-4000-8000-000000000001' }])])))).toBe('claude-code:c0ffee00-0000-4000-8000-000000000001');
});

test('two live sessions in one repository: only the one that wrote the plan gets it, the main checkout or another worktree', () => {
  const live = model([harbor([{ session: 'sess-main' }, { session: 'sess-wt-a' }, { session: 'sess-wt-b' }])]);
  expect(to(planAgentOf(plan('harbor-wt-a'), versions({ session: 'sess-wt-a', host: 'claude-code' }), live))).toBe('claude-code:sess-wt-a');
  expect(to(planAgentOf(plan('harbor-wt-b'), versions({ session: 'sess-wt-b', host: 'claude-code' }), live))).toBe('claude-code:sess-wt-b');
  // Written in the main checkout: its own session, though the worktrees' sessions are live in the same project.
  expect(to(planAgentOf(plan('harbor'), versions({ session: 'sess-main', host: 'claude-code' }), live))).toBe('claude-code:sess-main');
});

test('the session that wrote the plan has ended: the page says and offers what it did before', () => {
  const others = model([harbor([{ session: 'sess-main' }])]);
  const ended = versions({ session: 'sess-gone', host: 'claude-code' });
  // From a worktree: no project matches, so no agent, as before (never the repository's other session by a guess).
  expect(to(planAgentOf(plan('harbor-rotate-refresh-tokens-w'), ended, others))).toBe('none');
  // Under the repository's own name: matched by the folder's name only, so New message asks.
  expect(to(planAgentOf(plan('harbor'), ended, others))).toBe('pick');
  // Matched by the project's id: that one agent.
  expect(to(planAgentOf(plan('harbor', { project_id: 'prj_harbor' }), ended, others))).toBe('claude-code:sess-main');
});

test('two repositories whose folders share a name, or share it after the cut: never the other one', () => {
  const work = { id: 'prj_work', name: 'fern-api-gateway-service-for-teams', root: '/Users/charlie/work/fern-api-gateway-service-for-teams', sessions: [{ session: 'sess-work' }] };
  const oss = { id: 'prj_oss', name: 'fern-api-gateway-service-for-tests', root: '/Users/charlie/oss/fern-api-gateway-service-for-tests', sessions: [{ session: 'sess-oss' }] };
  const cut = plan('fern-api-gateway-service-for-t');
  expect(to(planAgentOf(cut, versions({ session: 'sess-oss', host: 'claude-code' }), model([work, oss])))).toBe('claude-code:sess-oss');
  expect(to(planAgentOf(cut, versions({ session: 'sess-work', host: 'claude-code' }), model([work, oss])))).toBe('claude-code:sess-work');
  // The same name exactly, the author gone: New message's To list, which shows each folder, never one chosen.
  const ledgerA = { id: 'prj_a', name: 'ledger', root: '/Users/charlie/work/ledger', sessions: [{ session: 'sess-a' }] };
  const ledgerB = { id: null, name: 'ledger', root: '/Users/charlie/oss/ledger', sessions: [{ session: 'sess-b' }] };
  expect(to(planAgentOf(plan('ledger'), versions({ session: 'sess-gone', host: 'claude-code' }), model([ledgerA, ledgerB])))).toBe('pick');
  expect(to(planAgentOf(plan('ledger'), versions({ session: 'sess-b', host: 'claude-code' }), model([ledgerA, ledgerB])))).toBe('claude-code:sess-b');
});

test('a worktree folder named nothing like the repository, and a repository folder plan review renames', () => {
  // Claude Code's own isolation: `.claude/worktrees/agent-…`.
  expect(to(planAgentOf(plan('agent-a1b2c3d4'), versions({ session: 'sess-agent', host: 'claude-code' }), model([harbor([{ session: 'sess-main' }, { session: 'sess-agent' }])])))).toBe('claude-code:sess-agent');
  // `Quill_Docs` is "quill-docs" to plan review and "Quill_Docs" to the Inbox.
  const quill = { id: 'prj_quill', name: 'Quill_Docs', root: '/Users/charlie/code/Quill_Docs', sessions: [{ session: 'sess-q' }] };
  expect(to(planAgentOf(plan('quill-docs'), versions({ session: 'sess-q', host: 'claude-code' }), model([quill])))).toBe('claude-code:sess-q');
});

test('a plan saved before Plans was on records no session: the project rules alone, as before', () => {
  const none = versions(null, null);
  expect(to(planAgentOf(plan('harbor-rotate-refresh-tokens-w'), none, model([harbor([{ session: 'sess-main' }])])))).toBe('none');
  expect(to(planAgentOf(plan('harbor'), none, model([harbor([{ session: 'sess-main' }])])))).toBe('pick');
  expect(to(planAgentOf(plan('harbor', { project_root: '/Users/charlie/code/harbor' }), none, model([harbor([{ session: 'sess-main' }])])))).toBe('claude-code:sess-main');
});

test('a session id is its host’s: another host’s session with the same id, or a session that is not the author, is never taken for it', () => {
  const sameId = model([harbor([{ session: 'sess-1', host: 'codex' }])]);
  expect(to(planAgentOf(plan('harbor-wt'), versions({ session: 'sess-1', host: 'claude-code' }), sameId))).toBe('none');
  // A session this Inbox lists that is not the author (another computer's agent among them) is not the author.
  const elsewhere = model([{ id: 'prj_far', name: 'harbor', root: '/Users/bob/code/harbor', sessions: [{ session: 'sess-far' }] }]);
  expect(to(planAgentOf(plan('harbor'), versions({ session: 'sess-here', host: 'claude-code' }), elsewhere))).toBe('pick');
  // A version recorded before hosts were kept: the id alone.
  expect(to(planAgentOf(plan('harbor-wt'), versions({ session: 'sess-1', host: null }), sameId))).toBe('codex:sess-1');
});

test('T3 Code: its thread in a T3 worktree, recorded and polled as host t3 with the thread id', () => {
  const thread = 'thread:project:harbor:5f0c2a9e-1d3b-4c6a-9e8f-0a1b2c3d4e5f';
  const live = model([harbor([{ session: 'sess-main' }, { session: thread, host: 't3', label: 'Rotate tokens' }])]);
  const agent = planAgentOf(plan('t3code-5f0c2a9e'), versions({ session: thread, host: 't3' }), live);
  expect(agent).toEqual({ kind: 'session', session: thread, host: 't3', label: 'Rotate tokens' });
});

test('a plan with its thread keeps going into the thread', () => {
  const live = model([harbor([{ session: 'sess-wt' }])]);
  expect(planAgentOf(plan('harbor-wt', { thread_id: 'msg_01M7JKWTSFEGR2XJQEJ1R2GHCQ' }), versions({ session: 'sess-wt', host: 'claude-code' }), live)).toMatchObject({ kind: 'thread', thread: 'msg_01M7JKWTSFEGR2XJQEJ1R2GHCQ' });
  expect(to(planAgentOf(plan('harbor-wt'), versions({ session: 'sess-wt', host: 'claude-code' }), null))).toBe('none');
});
