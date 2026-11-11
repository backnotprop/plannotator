/**
 * The list row's grey slot under option A (the owner's decision of 2026-11-10), one case per cell of the state
 * matrix in briefs `session-names-states.md` (§3, numbered as there). The failures this catches: a name shown in a
 * project with one live session (rows change for nobody's benefit); the project shown where rows of one project would
 * read alike; the generated title or a default hiding the name the person gave; two rows reading the same; a default
 * that changes between reads; a long name cut twice (the slot's cut, then the column's), a same-name code cut off, or a long name that loses its
 * whole form in the tooltip.
 * The live-count hold is severalSessions.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { rowSlot, sessionCode, type RowSlotInput } from './rowSlot';

const P = 'plannotator';
const base = (over: Partial<RowSlotInput>): RowSlotInput => ({ project: P, session: 'cc-a', names: {}, several: true, peers: [{ session: 'cc-a' }, { session: 'cc-b' }], ...over });
const code = (session: string, peers = ['cc-a', 'cc-b']) => sessionCode(session, peers);

type Case = [cell: string, input: RowSlotInput, slot: string, tip: string | null];

const LONG = 'Migrate auth tokens from the legacy cookie store to JWTs';
const cases: Case[] = [
  ['0 one live session: the project, whatever the name', base({ several: false, names: { label: 'release 0.28.61' } }), P, null],
  ['1 named by the person', base({ names: { label: 'release 0.28.61' } }), 'release 0.28.61', `${P} · release 0.28.61`],
  ['2 named by the agent (OpenCode, DeepSeek Harness send it as the label)', base({ names: { label: 'Fix login redirect' } }), 'Fix login redirect', `${P} · Fix login redirect`],
  ['3 generated title only', base({ names: { title: 'Plannotator usage reference' } }), 'Plannotator usage reference', `${P} · Plannotator usage reference`],
  ['1+3 the person’s name wins over the generated title', base({ names: { label: 'docs sweep', title: 'Docs pass on 14 guides' } }), 'docs sweep', `${P} · docs sweep`],
  ['4 no name at all (Codex, Cline, an unnamed Pi): the default', base({ session: 'cx-1', peers: [{ session: 'cc-a' }, { session: 'cx-1' }] }), `${P}-${code('cx-1', ['cc-a', 'cx-1'])}`, `${P} · ${P}-${code('cx-1', ['cc-a', 'cx-1'])}`],
  ['4 Claude Code with no name: its own listed name (it rides as the title)', base({ names: { title: 'plannotator-3f' } }), 'plannotator-3f', `${P} · plannotator-3f`],
  ['6 two sessions with the same name each add their code', base({ names: { label: 'docs' }, peers: [{ session: 'cc-a', label: 'docs' }, { session: 'cc-b', label: 'Docs' }] }), `docs (${code('cc-a')})`, `${P} · docs (${code('cc-a')})`],
  ['6 a name equal to another’s generated title is alike too', base({ names: { label: 'docs' }, peers: [{ session: 'cc-a', label: 'docs' }, { session: 'cc-b', title: 'docs' }] }), `docs (${code('cc-a')})`, `${P} · docs (${code('cc-a')})`],
  ['7 a very long name: cut once, at its end (as the column cuts), whole in the tooltip', base({ names: { label: LONG } }), 'Migrate auth tokens from the le…', `${P} · ${LONG}`],
  ['6+7 two long names alike: the code stays after the cut', base({ names: { label: LONG }, peers: [{ session: 'cc-a', label: LONG }, { session: 'cc-b', label: LONG }] }), `Migrate auth tokens from t… (${code('cc-a')})`, `${P} · ${LONG} (${code('cc-a')})`],
  ['8 right-to-left and emoji names are drawn as they are', base({ names: { label: 'إصلاح 🔧' } }), 'إصلاح 🔧', `${P} · إصلاح 🔧`],
  ['8 a blank name is no name: the next source', base({ names: { label: '   ', title: 'plannotator-3f' } }), 'plannotator-3f', `${P} · plannotator-3f`],
  ['9 an ended session with no name left (Inbox restarted): the default', base({ session: 'gone-1', peers: [{ session: 'cc-a' }, { session: 'cc-b' }] }), `${P}-${code('gone-1')}`, `${P} · ${P}-${code('gone-1')}`],
  ['12 a thread with several sessions: the row’s own session is named', base({ session: 'cc-b', names: { label: 'docs sweep' }, peers: [{ session: 'cc-a', label: 'release 0.28.61' }, { session: 'cc-b', label: 'docs sweep' }] }), 'docs sweep', `${P} · docs sweep`],
  ['16 another host in the project: named the same way', base({ session: 'pi-1', names: { label: 'Refactor billing exports' } }), 'Refactor billing exports', `${P} · Refactor billing exports`],
  ['19 a row with no session (CLI, raw MCP, a note): the project', base({ session: null }), P, null],
  ['20 the project’s name is what the row shows (a combined project’s head)', base({ project: 'ai-collab', names: {} , session: 'cc-a' }), `ai-collab-${code('cc-a')}`, `ai-collab · ai-collab-${code('cc-a')}`],
];

describe('the slot, state by state', () => {
  for (const [cell, input, text, tip] of cases) {
    test(cell, () => {
      const slot = rowSlot(input);
      expect(slot.text).toBe(text);
      expect(slot.kind === 'name' ? slot.tip : null).toBe(tip);
    });
  }
});

describe('the default name', () => {
  test('is stable across reads and windows, and two sessions of a project never share it', () => {
    expect(sessionCode('cc-a', ['cc-b'])).toBe(sessionCode('cc-a', ['cc-b']));
    // Many sessions in one project: every default distinct, each as short as it can be.
    const sessions = Array.from({ length: 300 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const codes = sessions.map((session) => sessionCode(session, sessions));
    expect(new Set(codes).size).toBe(sessions.length);
    expect(Math.min(...codes.map((c) => c.length))).toBe(2);
  });
});
