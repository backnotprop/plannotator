/**
 * What the agent-note dialog and Settings → Agents show, from
 * `GET /api/inbox/agents` (the approved "inbox-agent-awareness" design, and
 * "inbox-agent-note-dialog", which asks once per agent in a dialog). Pure.
 */
import {
  INBOX_AGENT_LABELS,
  INBOX_NOTE_AGENT_IDS,
  inboxElsewhereText,
  type InboxAgentId,
  type InboxAgentRow,
  type InboxAgentsModel,
  type InboxConnectReport,
  type InboxNoteAgentId,
} from '@plannotator/core/inbox-types';

/** Agents that can take a note now: found, reaching the Inbox, no note yet, a file to put it in, and not failed this run. */
export function noteCandidates(model: InboxAgentsModel): InboxAgentRow[] {
  const failed = new Set(model.last_report?.failed.map((f) => f.agent) ?? []);
  return model.agents.filter(
    (row) => row.detected && row.note !== null && (row.note.state === 'absent' || row.note.state === 'manual') && row.reach.on && !failed.has(row.id),
  );
}

/** The agents already asked about the note. An Inbox of 0.28.18 or older says only whether it asked (once, in all). */
export function notesAskedOf(model: InboxAgentsModel): readonly InboxNoteAgentId[] {
  if (model.notes_asked) return model.notes_asked;
  return model.notes_offered ? INBOX_NOTE_AGENT_IDS : [];
}

/**
 * Who the dialog asks about: the candidates not asked yet (each agent is
 * asked once), Claude Code last as in the approved dialog ("Add to Codex,
 * Gemini CLI and Claude Code"). None with PLANNOTATOR_INBOX_NOTES=0.
 */
export function noteQuestionRows(model: InboxAgentsModel): InboxAgentRow[] {
  if (model.notes_env_off) return [];
  const asked = new Set<string>(notesAskedOf(model));
  const rows = noteCandidates(model).filter((row) => !asked.has(row.id));
  return [...rows.filter((row) => row.id !== 'claude-code'), ...rows.filter((row) => row.id === 'claude-code')];
}

/** Whether the dialog has anyone to ask about. */
export function noteQuestionOpen(model: InboxAgentsModel): boolean {
  return noteQuestionRows(model).length > 0;
}

/** The last run's news the person has not seen yet: the dialog's band. */
export function cardReport(model: InboxAgentsModel): InboxConnectReport | null {
  const report = model.last_report;
  if (!report || report.seen || report.skipped) return null;
  const news =
    report.added.length +
    report.failed.length +
    report.foreign.length +
    (report.manual_why?.length ?? 0) +
    (report.trusted?.length ?? 0) +
    (report.trust_failed?.length ?? 0) +
    (report.elsewhere?.length ?? 0);
  return news > 0 ? report : null;
}

/** The band's lines (option A of the approved dialog): what was connected, who needs a person, what failed, whose entry is someone else's. */
export interface BandLines {
  connected: string | null;
  /** Agents this run registered Plannotator with as a trusted sender (Qwen Code): how far that reaches, and how to undo it. */
  trusted: string | null;
  /** Agents whose trusted sender failed, or was removed in the agent: replies wait until they read the Inbox. */
  trustFailed: { agent: InboxAgentId; text: string }[];
  byHand: string | null;
  failed: { agent: InboxAgentId; text: string }[];
  foreign: { agent: InboxAgentId; text: string }[];
  /** Connected in another file than this Inbox's environment names (`QWEN_HOME` differs): left there; Settings moves it. */
  elsewhere: { agent: InboxAgentId; text: string }[];
}

export function bandLines(report: InboxConnectReport): BandLines {
  const label = (id: InboxAgentId) => INBOX_AGENT_LABELS[id];
  const manual = [...new Set((report.manual_why ?? []).map((m) => m.agent))];
  return {
    connected: report.added.length > 0 ? `Connected ${joinNames(report.added.map(label))} to the Inbox${report.first ? '' : ' (new on this computer)'}.` : null,
    trusted: report.trusted?.length
      ? `Plannotator can now send your replies straight into any running ${joinNames(report.trusted.map(label))} session, without it asking you first. Turn this off in Settings → Agents.`
      : null,
    trustFailed: (report.trust_failed ?? []).map((f) => ({ agent: f.agent, text: `${label(f.agent)} won't get your replies by itself: ${sentence(tidyReason(f.reason))}` })),
    byHand: manual.length > 0 ? `${joinNames(manual.map(label))} ${manual.length === 1 ? 'needs' : 'need'} connecting by hand:` : null,
    failed: report.failed.map((f) => ({ agent: f.agent, text: `Couldn't connect ${label(f.agent)}: ${sentence(tidyReason(f.reason))}` })),
    foreign: report.foreign.map((f) => ({ agent: f.agent, text: `${label(f.agent)} has its own plannotator-inbox entry${f.path ? ` in ${f.path}` : ''}; Plannotator left it alone.` })),
    elsewhere: (report.elsewhere ?? []).map((moved) => ({ agent: moved.agent, text: inboxElsewhereText(moved) })),
  };
}

/**
 * A reason as one tidy clause. An agent CLI's own message rides in
 * parentheses ("codex mcp add exited with code 3 (boom: … (permission
 * denied))"); when that message ends in a parenthesis of its own, the outer
 * pair is unwrapped to a colon, so the line never ends "))".
 */
export function tidyReason(reason: string): string {
  const text = reason.trim();
  if (!text.endsWith('))')) return text;
  let depth = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === ')') depth++;
    else if (text[i] === '(' && --depth === 0) {
      if (i === 0 || text[i - 1] !== ' ') return text;
      return `${text.slice(0, i - 1)}: ${text.slice(i + 1, -1)}`;
    }
  }
  return text;
}

/** A clause ended with one full stop (none added after ".", "!" or "?"). */
export function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** "Codex", "Codex and Gemini CLI", "Codex, Gemini CLI and Claude Code". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Who the primary names: up to three agents by name, "N agents" for four or more. */
export function whoLabel(names: readonly string[]): string {
  return names.length > 3 ? `${names.length} agents` : joinNames(names);
}

/** The primary button: it names who it adds to; with nothing ticked it closes without adding. Never disabled. */
export function primaryAction(names: readonly string[]): { label: string; add: boolean } {
  if (names.length === 0) return { label: "Don't add a note", add: false };
  return { label: `Add to ${whoLabel(names)}`, add: true };
}

/** Where Cursor keeps its global rules (in the app, not a file). */
export const CURSOR_RULES_PLACE = 'Customize → Rules';

/**
 * A note the person copies by hand (Cursor: its rules live in the app, so
 * nothing is written; the note is shown to copy). Plannotator never adds,
 * sees or removes it.
 */
export function noteCopiedByHand(row: Pick<InboxAgentRow, 'note'>): boolean {
  return row.note?.state === 'manual';
}

/** The note without its marker lines: what a person copies by hand (the markers promise a removal that never happens there). */
export function noteWithoutMarkers(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.startsWith('<!-- plannotator-inbox:'))
    .join('\n');
}

/**
 * The dialog's primary with copy-by-hand agents among the ticked ones: it
 * names only the agents a note is written for ("Add to Codex"); with only
 * copy-by-hand agents ticked it shows the note to copy. Never disabled.
 */
export function notePrimaryAction(picked: readonly Pick<InboxAgentRow, 'label' | 'note'>[]): { label: string; add: boolean } {
  const written = picked.filter((row) => !noteCopiedByHand(row)).map((row) => row.label);
  if (written.length > 0) return primaryAction(written);
  if (picked.length > 0) return { label: 'Show the note to copy', add: true };
  return primaryAction([]);
}

/** Every agent in the dialog starts ticked (the owner's answer, 2026-10-13: Claude Code too). */
export function defaultPicks(rows: readonly InboxAgentRow[]): Record<string, boolean> {
  return Object.fromEntries(rows.map((row) => [row.id, true]));
}

/** What a note result shows in its row. */
export function noteResultLabel(result: { ok: true; action: string } | { ok: false }): 'Created' | 'Added' | 'Copy by hand' | 'Not added' {
  if (!result.ok) return 'Not added';
  if (result.action === 'manual') return 'Copy by hand';
  return result.action === 'created' ? 'Created' : 'Added';
}

/**
 * A path cut in the middle: the folders (`head`) shrink with "…"; the end of
 * the file name (`tail`, its last 22 characters when the name is long) always
 * shows. The whole path stays in the DOM.
 */
export function splitPath(path: string): { head: string; tail: string } {
  const slash = path.lastIndexOf('/') + 1;
  const name = path.length - slash;
  const keep = name > 28 ? 22 : name;
  return { head: path.slice(0, path.length - keep), tail: path.slice(path.length - keep) };
}
