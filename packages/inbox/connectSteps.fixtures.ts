import { INBOX_AGENT_IDS, INBOX_AGENT_LABELS, type InboxAgentId, type InboxAgentRow, type InboxAgentsModel } from '@plannotator/core/inbox-types';

type Reach = InboxAgentRow['reach'];
const reach = (over: Partial<Reach>): Reach => ({ kind: 'mcp', on: false, state: 'not_connected', path: null, locked: false, reason: null, ...over });
const host = (id: InboxAgentId) => id === 'claude-code' || id === 'pi' || id === 'opencode';

function agent(id: InboxAgentId, over: Partial<InboxAgentRow> = {}): InboxAgentRow {
  return {
    id,
    label: INBOX_AGENT_LABELS[id],
    detected: false,
    reach: host(id) ? reach({ kind: id === 'opencode' ? 'manual' : 'mcp', state: id === 'opencode' ? 'manual' : 'not_connected' }) : reach({}),
    tool: host(id) ? { on: false, locked: false } : null,
    reminder: host(id) ? { on: false, locked: false, needs_tool: true } : null,
    note: null,
    plugin: host(id) ? { installed: false } : null,
    ...over,
  };
}

export const ready = (): Partial<InboxAgentRow> => ({ detected: true, reach: reach({ kind: 'tool', on: true, state: 'connected' }), plugin: { installed: true } });
export const toolOff = (locked = false): Partial<InboxAgentRow> => ({
  detected: true,
  reach: reach({ kind: 'tool', on: false, state: 'off', locked }),
  tool: { on: false, locked },
  plugin: { installed: true },
});
export const missing = (id: InboxAgentId): Partial<InboxAgentRow> => ({
  detected: true,
  reach: reach(id === 'pi' ? { kind: 'mcp', state: 'not_connected' } : { kind: 'manual', state: 'manual', reason: id === 'claude-code' ? "install Plannotator's Claude Code plugin" : "add Plannotator's OpenCode plugin, or the server to opencode.json" }),
  plugin: { installed: false },
});
export const viaMcp = (id: InboxAgentId): Partial<InboxAgentRow> => ({ detected: true, reach: reach({ kind: 'mcp', on: true, state: 'connected', path: `~/.${id}/config` }) });

export function agentsModel(rows: Partial<Record<InboxAgentId, Partial<InboxAgentRow>>>, over: Partial<InboxAgentsModel> = {}): InboxAgentsModel {
  return {
    agents: INBOX_AGENT_IDS.map((id) => agent(id, rows[id] ?? {})),
    last_report: null,
    connecting: false,
    connect_env_off: false,
    tool_env: null,
    notes_offered: true,
    note_text: '',
    ...over,
  };
}

export const SCENARIOS = {
  typical: () => agentsModel({ 'claude-code': ready(), pi: toolOff(), opencode: missing('opencode'), codex: viaMcp('codex'), cursor: viaMcp('cursor') }),
  missing: () => agentsModel({ 'claude-code': missing('claude-code'), pi: viaMcp('pi'), codex: viaMcp('codex') }),
  none: () => agentsModel({}),
  locked: () =>
    agentsModel(
      { 'claude-code': toolOff(true), pi: toolOff(true), opencode: missing('opencode'), codex: viaMcp('codex'), cursor: viaMcp('cursor') },
      { tool_env: false },
    ),
} as const;
