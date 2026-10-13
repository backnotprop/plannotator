/**
 * What the first-open card and Settings → Agents show, from
 * `GET /api/inbox/agents` (the approved "inbox-agent-awareness" design). Pure.
 */
import {
  inboxAgentList,
  type InboxAgentRow,
  type InboxAgentsModel,
  type InboxConnectReport,
  type InboxNoteAgentId,
} from '@plannotator/core/inbox-types';

/** Agents that can take a note now: found, reaching the Inbox, no note yet, a file to put it in, and not failed this run. */
export function noteCandidates(model: InboxAgentsModel): InboxAgentRow[] {
  const failed = new Set(model.last_report?.failed.map((f) => f.agent) ?? []);
  return model.agents.filter(
    (row) => row.detected && row.note !== null && row.note.state === 'absent' && row.reach.on && !failed.has(row.id),
  );
}

/** The card's head: the last run's news the person has not closed yet. */
export function cardReport(model: InboxAgentsModel): InboxConnectReport | null {
  const report = model.last_report;
  if (!report || report.seen) return null;
  return report.added.length > 0 || report.failed.length > 0 || report.foreign.length > 0 ? report : null;
}

/** Whether the one-time note question is still open and has someone to ask about. */
export function noteQuestionOpen(model: InboxAgentsModel): boolean {
  return !model.notes_env_off && !model.notes_offered && noteCandidates(model).length > 0;
}

/** "Connected Codex, Gemini CLI and Cursor to the Inbox." and the muted rest. */
export function headLines(report: InboxConnectReport): { bold: string | null; rest: string } {
  const claude = report.claude_code ? 'Claude Code was already on. ' : '';
  if (report.added.length === 0) return { bold: null, rest: claude.trim() };
  const fresh = report.first ? '' : ' (new on this computer)';
  return {
    bold: `Connected ${inboxAgentList(report.added)} to the Inbox${fresh}.`,
    rest: `${claude}${report.added.length === 1 ? 'It starts' : 'Each one starts'} using it in its next session.${report.added.includes('claude-app') ? ' Restart the Claude app to use it there.' : ''}`,
  };
}

/** "Add to 2 files", "Add the note" at none. */
export function addLabel(count: number): string {
  if (count === 0) return 'Add the note';
  return `Add to ${count} file${count === 1 ? '' : 's'}`;
}

/** What a note result says after Add. */
export function noteResultLine(result: { ok: true; action: string; path: string } | { ok: false; reason: string }): string {
  if (!result.ok) return result.reason;
  switch (result.action) {
    case 'created':
      return `Created ${result.path}`;
    case 'added':
      return `Added a marked section to ${result.path}`;
    case 'updated':
      return `Updated the note in ${result.path}`;
    case 'kept-edited':
      return `${result.path} has the note as you edited it`;
    default:
      return `${result.path} already has the note`;
  }
}

/**
 * The ticks by default (DESIGN.md, question 2): unticked for the agents
 * Plannotator already reminds at each session start (Claude Code with its
 * plugin, Pi and OpenCode with Plannotator's extension or plugin: their reach
 * is the tool), ticked for the rest.
 */
export function defaultPicks(model: InboxAgentsModel): Record<InboxNoteAgentId, boolean> {
  const picks = {} as Record<InboxNoteAgentId, boolean>;
  for (const row of noteCandidates(model)) picks[row.id as InboxNoteAgentId] = row.reach.kind !== 'tool';
  return picks;
}
