import { INBOX_CLAUDE_PLUGIN_INSTALL } from '@plannotator/core/inbox-launch-ready';
import { INBOX_AGENT_IDS, INBOX_HOST_NAMES, INBOX_MCP_WAKE_MIN_VERSIONS, INBOX_MCP_WAKING_HOSTS, INBOX_WAKING_HOSTS, inboxToolCostText, type InboxAgentId, type InboxAgentRow, type InboxAgentsModel } from '@plannotator/core/inbox-types';
import type { HarnessId } from './harnesses';

export const PLUGIN_HOSTS = ['claude-code', 'pi', 'opencode'] as const;
export type PluginHost = (typeof PLUGIN_HOSTS)[number];

export function isPluginHost(id: string): id is PluginHost {
  return (PLUGIN_HOSTS as readonly string[]).includes(id);
}

export const PLUGIN_WORD: Readonly<Record<PluginHost, 'plugin' | 'extension'>> = { 'claude-code': 'plugin', pi: 'extension', opencode: 'plugin' };

export type ConnectState = 'ready' | 'tool-off' | 'mcp-only' | 'missing' | 'mcp' | 'connect' | 'manual' | 'absent';

export interface ConnectRow {
  id: InboxAgentId;
  label: string;
  state: ConnectState;
  locked: boolean;
  chosenOff: boolean;
  offNote?: string;
  generation?: '1' | '2';
  wakes?: boolean;
  reason: string | null;
}

/** `live`: a session of this host is polling the Inbox now, so the host counts as connected whatever the readable files say. */
export function connectRowOf(row: InboxAgentRow, live = false): ConnectRow | null {
  const base: Omit<ConnectRow, 'state'> = { id: row.id, label: row.label, locked: false, chosenOff: false, reason: row.reach.reason, ...(row.plugin?.generation ? { generation: row.plugin.generation } : {}), ...(typeof row.wakes === 'boolean' ? { wakes: row.wakes } : {}) };
  if (isPluginHost(row.id)) {
    if (live) return { ...base, state: 'ready' };
    if (!row.detected) return { ...base, state: 'absent' };
    if (row.plugin?.disabled || row.tool?.mod_off) {
      if (row.reach.kind === 'mcp' && row.reach.on) return { ...base, state: 'mcp' };
      const offNote = row.plugin?.disabled ? (row.plugin.managed ? 'plugin turned off by managed settings' : 'plugin turned off') : 'Plannotator mod turned off';
      return { ...base, state: 'tool-off', locked: row.reach.locked, chosenOff: true, offNote };
    }
    const installed = row.plugin ? row.plugin.installed : row.reach.kind === 'tool';
    if (installed && row.reach.kind === 'tool') {
      if (row.reach.on) return { ...base, state: 'ready' };
      return { ...base, state: 'tool-off', locked: row.reach.locked, chosenOff: row.tool?.chosen_off === true };
    }
    if (row.reach.kind === 'mcp' && row.reach.on) return { ...base, state: 'mcp-only' };
    return { ...base, state: 'missing' };
  }
  if (!row.detected) return null;
  if (row.reach.kind === 'tool') {
    if (live || row.reach.on) return { ...base, state: 'ready' };
    return { ...base, state: 'tool-off', locked: row.reach.locked, chosenOff: row.tool?.chosen_off === true };
  }
  if (row.reach.on) return { ...base, state: 'mcp' };
  if (row.reach.kind === 'manual') return { ...base, state: 'manual' };
  if (row.reach.kind === 'mcp' && row.reach.state === 'not_connected') return { ...base, state: 'connect' };
  return null;
}

export function isDone(row: ConnectRow): boolean {
  return row.state === 'ready' || row.state === 'mcp' || row.state === 'mcp-only';
}

export function isStep(row: ConnectRow): boolean {
  if (row.state === 'tool-off') return !row.locked && !row.chosenOff;
  return row.state === 'missing' || row.state === 'mcp-only' || row.state === 'connect' || row.state === 'manual';
}

export function stepOrder(row: ConnectRow): number {
  const host = PLUGIN_HOSTS.indexOf(row.id as PluginHost);
  if (host >= 0) return host + 1 + ({ 'tool-off': 0, missing: 10, 'mcp-only': 20 } as Partial<Record<ConnectState, number>>)[row.state]!;
  return 40 + INBOX_AGENT_IDS.indexOf(row.id);
}

export interface ConnectPlan {
  blocked: boolean;
  rows: ConnectRow[];
  found: ConnectRow[];
  steps: ConnectRow[];
  next: ConnectRow | null;
  done: ConnectRow[];
  later: ConnectRow[];
  absent: ConnectRow[];
}

export function connectPlan(model: InboxAgentsModel, skipped: readonly string[] = [], live: ReadonlySet<string> = new Set()): ConnectPlan {
  const rank = (row: ConnectRow) => (isPluginHost(row.id) ? PLUGIN_HOSTS.indexOf(row.id) : PLUGIN_HOSTS.length + INBOX_AGENT_IDS.indexOf(row.id));
  const rows = model.agents
    .map((row) => connectRowOf(row, live.has(row.id)))
    .filter((row): row is ConnectRow => row !== null)
    .sort((a, b) => rank(a) - rank(b));
  const found = rows.filter((row) => row.state !== 'absent');
  const all = found.filter(isStep).sort((a, b) => stepOrder(a) - stepOrder(b));
  const steps = all.filter((row) => !skipped.includes(row.id));
  const next = steps[0] ?? null;
  const locked = found.filter((row) => row.state === 'tool-off' && (row.locked || row.chosenOff));
  const putOff = all.filter((row) => skipped.includes(row.id));
  const done = found.filter(isDone);
  return {
    blocked: found.length > 0 && !next && done.length === 0,
    rows,
    found,
    steps,
    next,
    done,
    later: [...steps.slice(1), ...putOff, ...locked],
    absent: rows.filter((row) => row.state === 'absent'),
  };
}

export function stepEyebrow(plan: ConnectPlan): { label: string; count: string } {
  return { label: 'Next step', count: plan.steps.length > 1 ? `1 of ${plan.steps.length}` : 'last one' };
}

export function stepTitle(row: ConnectRow): string {
  const word = isPluginHost(row.id) ? PLUGIN_WORD[row.id] : 'plugin';
  switch (row.state) {
    case 'tool-off':
      return `Turn on ${row.label}'s Inbox tool`;
    case 'mcp-only':
      return `Give ${row.label} Plannotator's ${word}`;
    case 'missing':
      return `Connect ${row.label} with Plannotator's ${word}`;
    case 'connect':
      return `Connect ${row.label}`;
    case 'manual':
      return `Connect ${row.label} yourself`;
    default:
      return row.label;
  }
}

export function stepText(row: ConnectRow): { text: string; cost?: string } {
  const word = isPluginHost(row.id) ? PLUGIN_WORD[row.id] : 'plugin';
  switch (row.state) {
    case 'tool-off':
      if (row.id === 'claude-code') return { text: 'Turn it on so Claude Code can send you messages and get your replies in the session.' };
      return {
        text: `Plannotator's ${word} is installed. Turn its Inbox tool on so ${row.label} can send you messages and get your replies in the session. It adds the tool to every ${row.label} request: `,
        cost: inboxToolCostText(row.id as 'pi' | 'opencode'),
      };
    case 'mcp-only':
      return { text: `${row.label} sees your replies only when it checks the Inbox. With Plannotator's ${word}, they arrive as a new turn on their own, and you can message a running session.` };
    case 'missing':
      if (row.id === 'claude-code') return { text: "Plannotator's plugin connects it: your replies arrive as a new turn on their own." };
      if (row.id === 'opencode' && row.generation === '1') {
        return { text: "Plannotator's plugin connects it. OpenCode 1 sees your replies when it checks the Inbox; on OpenCode 2 they arrive as a new turn on their own." };
      }
      if (row.id === 'opencode') return { text: "Plannotator's plugin connects it: on OpenCode 2 your replies arrive as a new turn on their own." };
      return { text: `Plannotator's ${word} connects it.` };
    case 'connect':
      if (INBOX_MCP_WAKING_HOSTS.includes(row.id)) {
        return { text: `Adds the Inbox's MCP server to ${row.label}. ${mcpWakeName(row.id)}: your replies arrive as a new turn on their own.` };
      }
      return { text: `Adds the Inbox's MCP server to ${row.label}. ${row.label} sees your replies when it checks the Inbox; it can't be woken.` };
    case 'manual':
      return { text: row.reason ? `Only you can add it here: ${row.reason}.` : 'Only you can add it here.' };
    default:
      return { text: '' };
  }
}

export function blockedText(plan: ConnectPlan, opts: { skipped: readonly string[]; toolEnv: boolean | null }): { text: string; settings: boolean } {
  const names = (rows: readonly ConnectRow[]) => {
    const labels = rows.map((row) => row.label);
    return labels.length <= 1 ? labels.join('') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
  };
  const off = plan.found.filter((row) => row.state === 'tool-off' && (row.chosenOff || row.offNote));
  const locked = plan.found.filter((row) => row.state === 'tool-off' && row.locked && !off.includes(row));
  const putOff = plan.found.filter((row) => opts.skipped.includes(row.id));
  const parts: string[] = [];
  if (locked.length) parts.push(`PLANNOTATOR_INBOX_TOOL=${opts.toolEnv ? '1' : '0'} keeps the Inbox tool off for ${names(locked)}.`);
  for (const row of off) {
    if (row.offNote === 'plugin turned off') parts.push(`Plannotator's plugin is turned off in ${row.label} (claude plugin enable plannotator@plannotator turns it back on).`);
    else if (row.offNote === 'plugin turned off by managed settings') parts.push(`Your organization's managed settings turn Plannotator's plugin off in ${row.label}.`);
    else if (row.offNote) parts.push(`Plannotator's ${row.label} mod is turned off (PLANNOTATOR_CLAUDE_MOD or claudeCodeMod), so ${row.label} has no Inbox tool.`);
  }
  const toolOff = off.filter((row) => !row.offNote);
  if (toolOff.length) parts.push(`You turned the Inbox tool off for ${names(toolOff)}.`);
  if (putOff.length) parts.push(`You put ${names(putOff)} off for later.`);
  return { text: parts.join(' '), settings: toolOff.length > 0 };
}

const andList = (names: readonly string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
const wakeName = (host: string) => (host === 'opencode' ? 'OpenCode 2' : (INBOX_HOST_NAMES[host] ?? host));
export function mcpWakeName(host: string): string {
  const min = INBOX_MCP_WAKE_MIN_VERSIONS[host];
  return min ? `${INBOX_HOST_NAMES[host] ?? host} ${min.replace(/\.0$/, '')} or later` : (INBOX_HOST_NAMES[host] ?? host);
}
const WAKE_LINE_UNNAMED: ReadonlySet<string> = new Set(['dsh', 'cline']);
const BRIDGE_HOSTS = INBOX_WAKING_HOSTS.filter((host) => !INBOX_MCP_WAKING_HOSTS.includes(host) && !WAKE_LINE_UNNAMED.has(host));

export function wakeLine(mcpHosts: readonly string[] = []): string {
  const mcp = INBOX_MCP_WAKING_HOSTS.filter((host) => mcpHosts.includes(host));
  const through = mcp.length > 0 ? `, and in ${andList(mcp.map(mcpWakeName))} through MCP` : '';
  return `With Plannotator's connection, your replies arrive as a new turn on their own in ${andList(BRIDGE_HOSTS.map(wakeName))}${through}. Other agents see your reply the next time they check the Inbox.`;
}

export function mcpWakeLine(mcpHosts: readonly string[] = []): string {
  const mcp = INBOX_MCP_WAKING_HOSTS.filter((host) => mcpHosts.includes(host));
  if (mcp.length === 0) return "These reach the Inbox through MCP: they see your reply the next time they check it, and can't be woken.";
  const gets = mcp.length === 1 ? 'gets your reply as a new turn on its own' : 'get your reply as a new turn on their own';
  return `These reach the Inbox through MCP: ${andList(mcp.map(mcpWakeName))} ${gets}; the others see it the next time they check the Inbox, and can't be woken.`;
}

export function mcpWakingHostsHere(model: InboxAgentsModel | null | undefined): string[] {
  return (model?.agents ?? []).filter((row) => row.detected && INBOX_MCP_WAKING_HOSTS.includes(row.id)).map((row) => row.id);
}

export const WAKE_LINE = wakeLine();
export const MCP_WAKE_LINE = mcpWakeLine();

export const MCP_DONE_NOTE = 'MCP · sees replies when it checks';
export const MCP_WAKES_DONE_NOTE = 'MCP · replies arrive as a new turn';

export function mcpFoldHint(label: string): string {
  return `Works, but ${label} sees your replies only when it checks the Inbox; they don't arrive as a new turn.`;
}

export function doneNote(row: ConnectRow, opts: { live: boolean; turnedOn: boolean }): string {
  if (row.state === 'ready') {
    if (opts.turnedOn) return row.id === 'dsh' ? 'when DeepSeek Harness next starts' : 'next session';
    const word = isPluginHost(row.id) ? PLUGIN_WORD[row.id] : 'plugin';
    return opts.live ? `${word} · running now` : word;
  }
  if (row.state === 'mcp' && row.wakes === true) return MCP_WAKES_DONE_NOTE;
  return MCP_DONE_NOTE;
}

export function laterNote(row: ConnectRow, opts: { skipped: boolean; toolEnv: boolean | null }): string {
  if (row.state === 'tool-off' && row.offNote) return row.offNote;
  if (row.state === 'tool-off' && row.locked) return `locked by PLANNOTATOR_INBOX_TOOL=${opts.toolEnv ? '1' : '0'}`;
  if (row.state === 'tool-off' && row.chosenOff) return 'off';
  if (opts.skipped) return 'later';
  if (row.state === 'tool-off') return 'turn on';
  if (row.state === 'connect') return 'connect';
  if (row.state === 'manual') return 'yourself';
  return 'install';
}

export function harnessOf(id: InboxAgentId): HarnessId {
  return id as HarnessId;
}

export const CLAUDE_PLUGIN_INSTALL = INBOX_CLAUDE_PLUGIN_INSTALL;
export const PI_EXTENSION_INSTALL = 'pi install npm:@plannotator/pi-extension';
export const OPENCODE_PLUGIN_LINES = {
  '2': '"plugins": [{ "package": "@plannotator/opencode@latest" }]',
  '1': '"plugin": ["@plannotator/opencode@latest"]',
} as const;
export const OPENCODE_CONFIG_PATH = '~/.config/opencode/opencode.json';

export function tryWho(names: readonly string[]): string {
  return names.length ? `In a new ${names.slice(0, 2).join(' or ')} session, ask:` : 'Once an agent is connected, ask it in a new session:';
}

export const TRY_PROMPT = 'Send me a test message in my Plannotator Inbox.';
