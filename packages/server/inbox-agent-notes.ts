/**
 * The Inbox note in each agent's own instructions file (the approved
 * "inbox-agent-awareness" design, decision 5; HOOKS.md section 6.2).
 *
 * Written by itself (approval "inbox-agent-note-auto", which superseded the
 * one-time dialog) for every connected agent proven to load it
 * (INBOX_NOTE_AUTO_AGENT_IDS: Claude Code, Codex, Gemini CLI, Pi, OpenCode),
 * once per agent, at the Inbox's start and after each connecting run
 * (autoAddInboxNotes). Never for an agent already asked (an old dialog's Not
 * now or Don't add a note), one the person turned off in Settings, or with
 * PLANNOTATOR_INBOX_NOTES=0. Qwen Code's note is still offered by the window's
 * one-time question, Cursor's copied by hand. A Settings switch and
 * `plannotator inbox --notes <ids>` add one too. A note already installed is
 * brought up to the current version by the Inbox's start, only while it is
 * byte for byte an earlier version Plannotator wrote (refreshInboxNotes).
 *
 * Where (honouring CLAUDE_CONFIG_DIR, CODEX_HOME, OPENCODE_CONFIG_DIR /
 * XDG_CONFIG_HOME, PI_CODING_AGENT_DIR, QWEN_HOME and Gemini's and Qwen's
 * `context.fileName`):
 *  - Claude Code: `~/.claude/rules/plannotator-inbox.md`, a file Plannotator owns.
 *  - Codex: `AGENTS.override.md` when Codex reads it (a file with text other than
 *    whitespace), else `AGENTS.md` (created when missing). An empty override is
 *    skipped by Codex; writing into it would hide the person's AGENTS.md.
 *  - OpenCode: `~/.config/opencode/AGENTS.md`, ONLY when it exists: creating it
 *    would stop OpenCode 1 reading the person's `~/.claude/CLAUDE.md`.
 *  - Pi: the first that exists of `AGENTS.override.md`, `AGENTS.md`,
 *    `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` (Pi reads only one); `AGENTS.md`
 *    created only when none does.
 *  - Gemini CLI: `~/.gemini/<context.fileName>`, default `GEMINI.md`.
 *  - Qwen Code: `$QWEN_HOME/<context.fileName>` (default folder `~/.qwen`), default `QWEN.md`.
 *  - Cursor: copied by hand into Customize → Rules in the app; Cursor documents no global rules file, so nothing is written.
 *
 * The block sits between markers at the END of the file, or right above a
 * Gemini CLI or Qwen Code memory section (`## Gemini Added Memories`, `## Qwen
 * Added Memories`): their memory tools add to that section up to the next `## `
 * heading, which would otherwise be the note's own. Exactly one start
 * before exactly one end: the block is ours; none: appended; anything else:
 * damaged, nothing is written. `inbox/agent-notes.json` keeps each block's
 * SHA-256, so a block the person edited is theirs and never overwritten (a
 * newer note version is written only over an untouched block). The one
 * exception: in an edited block that has a record, refreshInboxNotes swaps the
 * exact retired sentence "otherwise call `wait_for_reply`" for "otherwise read
 * the thread later with `read_thread`", touching no other byte and no record.
 * Writes keep
 * line endings and mode, follow symlinks, are atomic, and are skipped when
 * nothing changes (agent-files.ts).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  INBOX_AGENT_LABELS,
  INBOX_NOTE_AGENT_IDS,
  INBOX_NOTE_AUTO_AGENT_IDS,
  type InboxAgentNoteStatus,
  type InboxNoteAgentId,
  type InboxNoteAutoAdd,
} from "@plannotator/core/inbox-types";
import { loadConfig, saveConfig } from "@plannotator/shared/config";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import { type AgentFileRead, describeFsError, readAgentFile, stripJsonComments, withBom, writeAgentFileAtomic } from "./agent-files";
import {
  agentHomeAllowed,
  agentSpec,
  claudeConfigDir,
  codexHome,
  displayPath,
  geminiDir,
  qwenDir,
  openCodeConfigDir,
  inboxAgentReach,
  piAgentDir,
  readInboxAgents,
  type AgentEnvironment,
  type ConnectOptions,
} from "./inbox-agents";

/**
 * v3 (2026-10-27): v1's presence lines ("when the person isn't here", "When
 * they are here, ask in this chat instead") replaced by the chat-or-Inbox rule,
 * plus the check before a reply_to into a thread not read in this context
 * window and where a question's recommendation goes (v2, never released, had
 * those two lines after v1's). v4 (2026-10-27): v3 plus the follow-through
 * line (INBOX_FOLLOW_THROUGH_RULE) after the reply line; v3 shipped in
 * 0.28.34 and is on users' disks. v5 (2026-10-29): v4 plus the work-stream
 * line (INBOX_THREAD_RULE) after the follow-through line; v4 shipped in
 * 0.28.36 and is on users' disks. v6 (2026-10-31): v5 with the question line
 * reworded to keep the choices in their natural order (the owner: agents moved
 * their recommendation first) and, right after the ask line, one line that a
 * decision inside a report or summary still goes in a `:::question` block, one
 * per decision (the owner: agents hand decisions over as prose); v5 is on
 * users' disks, v6 was on no tag when this line went in, so it was amended in
 * place. v7 (2026-11-01): v6 with the reply line naming read_thread, since
 * wait_for_reply is gone from the Inbox; v6 is on users' disks. v8
 * (2026-11-02): v7 with the hand-over clause putting a summary's pictures in
 * place in the body (the owner: agents left them at the bottom as
 * attachments); v7 is on users' disks. v9 (2026-11-08): v8 plus one line
 * after the decision line, that an issue or PR outside the repo the session
 * started in is written owner/repo#123 or its URL (the owner, after a
 * chief-of-staff agent's bare refs linked into its own repo); v8 shipped in
 * 0.28.47 and is on users' disks. An earlier
 * block Plannotator wrote is brought
 * up to date at the Inbox's next start (refreshInboxNotes) or when the note
 * is added again (`--notes`, the Settings switch); a block the person edited
 * never is (bar the one retired sentence, above). Every version's text is frozen as literals and its block's hash
 * pinned (inbox-agent-notes-refresh.test.ts): a released note's bytes never
 * change without a new version, or the notes on disk would read as edited.
 */
export const INBOX_NOTE_VERSION = 9;
const noteStart = (version: number) =>
  `<!-- plannotator-inbox:start v${version} · added by Plannotator. Remove it in the Inbox's Settings or with \`plannotator uninstall\` -->`;
export const INBOX_NOTE_START = noteStart(INBOX_NOTE_VERSION);
export const INBOX_NOTE_END = "<!-- plannotator-inbox:end -->";

/** v1's body, exactly as 0.28.x wrote it: kept so a v1 block with no record still reads as Plannotator's own, untouched. */
const INBOX_NOTE_BODY_V1 = [
  "## Plannotator Inbox",
  "",
  "The person keeps a Plannotator Inbox on this computer: a window where they read what agents send and answer when they can.",
  "If you have a `plannotator_inbox` tool or a `plannotator-inbox` MCP server, use its `send_message` when the person isn't here to answer in this chat: to ask a decision only they can make (as a `:::question` block), or to hand over finished long work (put the files to read in `attachments`). Then keep working.",
  "Their reply comes back to this session by itself where your agent supports that; otherwise call `wait_for_reply`. When they are here, ask in this chat instead.",
].join("\n");

/** v2's body, exactly as builds before v3 wrote it (never released; frozen as literals so such a block still reads as Plannotator's own). */
const INBOX_NOTE_BODY_V2 = [
  INBOX_NOTE_BODY_V1,
  "Before reply_to into a thread you have not read in this context window, call read_thread with no id and match the subject.",
  'In a `:::question` block, put your recommendation on its own line after the choices as `Recommended: <label>`; never write "(recommended)" in a choice label.',
].join("\n");

/** v3's body, exactly as 0.28.34 wrote it (on users' disks; frozen as literals so such a block still reads as Plannotator's own). */
const INBOX_NOTE_BODY_V3 = [
  "## Plannotator Inbox",
  "",
  "The person keeps a Plannotator Inbox on this computer: a window where they read what agents send and answer when they can.",
  "If you have a `plannotator_inbox` tool or a `plannotator-inbox` MCP server, use its `send_message` to ask a decision only they can make (as a `:::question` block) or to hand over finished long work (put the files to read in `attachments`). Then keep working.",
  "Their reply comes back to this session by itself where your agent supports that; otherwise call `wait_for_reply`.",
  "A decision you sent to the Inbox stays there. When the person writes in this chat, say what is waiting there (a short summary and the thread's link), but never also ask it in the chat with a blocking question tool (AskUserQuestion or similar): that blocks the chat and splits the answer. Ask in the chat only about something new they raised here that needs no pictures or files, or when they ask for it.",
  "Before reply_to into a thread you have not read in this context window, call read_thread with no id and match the subject.",
  'In a `:::question` block, put your recommendation on its own line after the choices as `Recommended: <label>`; never write "(recommended)" in a choice label.',
].join("\n");

/** v4's body, exactly as 0.28.36 through 0.28.38 wrote it (on users' disks; frozen as literals so such a block still reads as Plannotator's own). */
const INBOX_NOTE_BODY_V4 = [
  "## Plannotator Inbox",
  "",
  "The person keeps a Plannotator Inbox on this computer: a window where they read what agents send and answer when they can.",
  "If you have a `plannotator_inbox` tool or a `plannotator-inbox` MCP server, use its `send_message` to ask a decision only they can make (as a `:::question` block) or to hand over finished long work (put the files to read in `attachments`). Then keep working.",
  "Their reply comes back to this session by itself where your agent supports that; otherwise call `wait_for_reply`.",
  "Be proactive about Inbox updates and about replying to the person through the Inbox when you think they would want you to. Don't withhold important updates or decisions, and don't batch updates to send later: proactivity is better than procrastination.",
  "A decision you sent to the Inbox stays there. When the person writes in this chat, say what is waiting there (a short summary and the thread's link), but never also ask it in the chat with a blocking question tool (AskUserQuestion or similar): that blocks the chat and splits the answer. Ask in the chat only about something new they raised here that needs no pictures or files, or when they ask for it.",
  "Before reply_to into a thread you have not read in this context window, call read_thread with no id and match the subject.",
  'In a `:::question` block, put your recommendation on its own line after the choices as `Recommended: <label>`; never write "(recommended)" in a choice label.',
].join("\n");

/** v5's body, exactly as builds before v6 wrote it (on users' disks; frozen as literals so such a block still reads as Plannotator's own). */
const INBOX_NOTE_BODY_V5 = [
  "## Plannotator Inbox",
  "",
  "The person keeps a Plannotator Inbox on this computer: a window where they read what agents send and answer when they can.",
  "If you have a `plannotator_inbox` tool or a `plannotator-inbox` MCP server, use its `send_message` to ask a decision only they can make (as a `:::question` block) or to hand over finished long work (put the files to read in `attachments`). Then keep working.",
  "Their reply comes back to this session by itself where your agent supports that; otherwise call `wait_for_reply`.",
  "Be proactive about Inbox updates and about replying to the person through the Inbox when you think they would want you to. Don't withhold important updates or decisions, and don't batch updates to send later: proactivity is better than procrastination.",
  "One thread per work stream, unless the person says otherwise.",
  "A decision you sent to the Inbox stays there. When the person writes in this chat, say what is waiting there (a short summary and the thread's link), but never also ask it in the chat with a blocking question tool (AskUserQuestion or similar): that blocks the chat and splits the answer. Ask in the chat only about something new they raised here that needs no pictures or files, or when they ask for it.",
  "Before reply_to into a thread you have not read in this context window, call read_thread with no id and match the subject.",
  'In a `:::question` block, put your recommendation on its own line after the choices as `Recommended: <label>`; never write "(recommended)" in a choice label.',
].join("\n");

/** v6's body, exactly as builds before v7 wrote it (on users' disks; frozen as literals so such a block still reads as Plannotator's own). */
const INBOX_NOTE_BODY_V6 = [
  "## Plannotator Inbox",
  "",
  "The person keeps a Plannotator Inbox on this computer: a window where they read what agents send and answer when they can.",
  "If you have a `plannotator_inbox` tool or a `plannotator-inbox` MCP server, use its `send_message` to ask a decision only they can make (as a `:::question` block) or to hand over finished long work (put the files to read in `attachments`). Then keep working.",
  "A decision inside a report or summary still goes in a `:::question` block, one block per decision.",
  "Their reply comes back to this session by itself where your agent supports that; otherwise call `wait_for_reply`.",
  "Be proactive about Inbox updates and about replying to the person through the Inbox when you think they would want you to. Don't withhold important updates or decisions, and don't batch updates to send later: proactivity is better than procrastination.",
  "One thread per work stream, unless the person says otherwise.",
  "A decision you sent to the Inbox stays there. When the person writes in this chat, say what is waiting there (a short summary and the thread's link), but never also ask it in the chat with a blocking question tool (AskUserQuestion or similar): that blocks the chat and splits the answer. Ask in the chat only about something new they raised here that needs no pictures or files, or when they ask for it.",
  "Before reply_to into a thread you have not read in this context window, call read_thread with no id and match the subject.",
  'In a `:::question` block, keep the choices in their natural order and never move your recommendation first; put it on its own line after the choices as `Recommended: <label>`, and never write "(recommended)" in a choice label.',
].join("\n");

/** v7's body, exactly as builds before v8 wrote it (on users' disks; frozen as literals so such a block still reads as Plannotator's own). */
const INBOX_NOTE_BODY_V7 = [
  "## Plannotator Inbox",
  "",
  "The person keeps a Plannotator Inbox on this computer: a window where they read what agents send and answer when they can.",
  "If you have a `plannotator_inbox` tool or a `plannotator-inbox` MCP server, use its `send_message` to ask a decision only they can make (as a `:::question` block) or to hand over finished long work (put the files to read in `attachments`). Then keep working.",
  "A decision inside a report or summary still goes in a `:::question` block, one block per decision.",
  "Their reply comes back to this session by itself where your agent supports that; otherwise read the thread later with `read_thread`.",
  "Be proactive about Inbox updates and about replying to the person through the Inbox when you think they would want you to. Don't withhold important updates or decisions, and don't batch updates to send later: proactivity is better than procrastination.",
  "One thread per work stream, unless the person says otherwise.",
  "A decision you sent to the Inbox stays there. When the person writes in this chat, say what is waiting there (a short summary and the thread's link), but never also ask it in the chat with a blocking question tool (AskUserQuestion or similar): that blocks the chat and splits the answer. Ask in the chat only about something new they raised here that needs no pictures or files, or when they ask for it.",
  "Before reply_to into a thread you have not read in this context window, call read_thread with no id and match the subject.",
  'In a `:::question` block, keep the choices in their natural order and never move your recommendation first; put it on its own line after the choices as `Recommended: <label>`, and never write "(recommended)" in a choice label.',
].join("\n");

/** v8's body, exactly as 0.28.47 through 0.28.53 wrote it (on users' disks; frozen as literals so such a block still reads as Plannotator's own). */
const INBOX_NOTE_BODY_V8 = [
  "## Plannotator Inbox",
  "",
  "The person keeps a Plannotator Inbox on this computer: a window where they read what agents send and answer when they can.",
  "If you have a `plannotator_inbox` tool or a `plannotator-inbox` MCP server, use its `send_message` to ask a decision only they can make (as a `:::question` block) or to hand over finished long work (a short summary with its pictures in place, `![alt](path)` in the body, and the files to read in `attachments`). Then keep working.",
  "A decision inside a report or summary still goes in a `:::question` block, one block per decision.",
  "Their reply comes back to this session by itself where your agent supports that; otherwise read the thread later with `read_thread`.",
  "Be proactive about Inbox updates and about replying to the person through the Inbox when you think they would want you to. Don't withhold important updates or decisions, and don't batch updates to send later: proactivity is better than procrastination.",
  "One thread per work stream, unless the person says otherwise.",
  "A decision you sent to the Inbox stays there. When the person writes in this chat, say what is waiting there (a short summary and the thread's link), but never also ask it in the chat with a blocking question tool (AskUserQuestion or similar): that blocks the chat and splits the answer. Ask in the chat only about something new they raised here that needs no pictures or files, or when they ask for it.",
  "Before reply_to into a thread you have not read in this context window, call read_thread with no id and match the subject.",
  'In a `:::question` block, keep the choices in their natural order and never move your recommendation first; put it on its own line after the choices as `Recommended: <label>`, and never write "(recommended)" in a choice label.',
].join("\n");

/**
 * The note (DESIGN.md section 2.3): true with or without the tool, so a
 * session without it is not misled. Loaded in every session of the agent, so
 * every line earns its place. v3 (the owner, 2026-10-27): chat or Inbox is
 * never a guess at whether the person is here; a decision in the Inbox stays
 * there, the chat only says what waits. v4 (the owner, 2026-10-27): be
 * proactive in the Inbox, the one wording of INBOX_FOLLOW_THROUGH_RULE
 * (kept a literal here; tests/inbox-guidance-parity.test.ts holds it equal).
 * v5 (the owner, 2026-10-29): one thread per work stream, the one wording of
 * INBOX_THREAD_RULE (a literal too, held equal by the same test). v6 (the
 * owner, 2026-10-31): choices stay in their natural order; only the
 * `Recommended:` line marks the pick, never its place; a decision inside a
 * report still goes in its own `:::question` block. v7 (2026-11-01): the reply
 * line says to read the thread later, wait_for_reply being gone. v8
 * (2026-11-02): a hand-over's pictures sit in place in the body, the files
 * to read in `attachments`. v9 (the owner, 2026-11-08, the chief-of-staff
 * report): an issue or PR outside the starting repo is written owner/repo#123
 * or its URL every time; the tool's INBOX_REF_LINK_RULE says the same at length.
 */
export const INBOX_NOTE_BODY = [
  "## Plannotator Inbox",
  "",
  "The person keeps a Plannotator Inbox on this computer: a window where they read what agents send and answer when they can.",
  "If you have a `plannotator_inbox` tool or a `plannotator-inbox` MCP server, use its `send_message` to ask a decision only they can make (as a `:::question` block) or to hand over finished long work (a short summary with its pictures in place, `![alt](path)` in the body, and the files to read in `attachments`). Then keep working.",
  "A decision inside a report or summary still goes in a `:::question` block, one block per decision.",
  "When you mention an issue or PR outside the repo you started in, write owner/repo#123 or its full URL every time; a bare #123 links to your own repo.",
  "Their reply comes back to this session by itself where your agent supports that; otherwise read the thread later with `read_thread`.",
  "Be proactive about Inbox updates and about replying to the person through the Inbox when you think they would want you to. Don't withhold important updates or decisions, and don't batch updates to send later: proactivity is better than procrastination.",
  "One thread per work stream, unless the person says otherwise.",
  "A decision you sent to the Inbox stays there. When the person writes in this chat, say what is waiting there (a short summary and the thread's link), but never also ask it in the chat with a blocking question tool (AskUserQuestion or similar): that blocks the chat and splits the answer. Ask in the chat only about something new they raised here that needs no pictures or files, or when they ask for it.",
  "Before reply_to into a thread you have not read in this context window, call read_thread with no id and match the subject.",
  'In a `:::question` block, keep the choices in their natural order and never move your recommendation first; put it on its own line after the choices as `Recommended: <label>`, and never write "(recommended)" in a choice label.',
].join("\n");

/** Cursor keeps its global rules in the app, so its note is copied by hand (the body only, never the markers). */
export const CURSOR_NOTE_REASON = "Cursor keeps its rules in the app: copy the note into Customize → Rules yourself. Plannotator can't see, update or remove that copy.";

export const INBOX_NOTE_BLOCK = `${INBOX_NOTE_START}\n${INBOX_NOTE_BODY}\n${INBOX_NOTE_END}`;

/** Every block an earlier Plannotator wrote, untouched (LF): read as Plannotator's own when no record names it. */
export const INBOX_NOTE_EARLIER_BLOCKS: readonly string[] = [
  `${noteStart(1)}\n${INBOX_NOTE_BODY_V1}\n${INBOX_NOTE_END}`,
  `${noteStart(2)}\n${INBOX_NOTE_BODY_V2}\n${INBOX_NOTE_END}`,
  `${noteStart(3)}\n${INBOX_NOTE_BODY_V3}\n${INBOX_NOTE_END}`,
  `${noteStart(4)}\n${INBOX_NOTE_BODY_V4}\n${INBOX_NOTE_END}`,
  `${noteStart(5)}\n${INBOX_NOTE_BODY_V5}\n${INBOX_NOTE_END}`,
  `${noteStart(6)}\n${INBOX_NOTE_BODY_V6}\n${INBOX_NOTE_END}`,
  `${noteStart(7)}\n${INBOX_NOTE_BODY_V7}\n${INBOX_NOTE_END}`,
  `${noteStart(8)}\n${INBOX_NOTE_BODY_V8}\n${INBOX_NOTE_END}`,
];

export const INBOX_AGENT_NOTES_FILE = "agent-notes.json";

/** Any version's start marker, and the end marker, each on its own line (a CRLF line too). */
const START_LINE = /^<!-- plannotator-inbox:start\b[^\r\n]*-->[ \t]*\r?$/gm;
const END_LINE = /^<!-- plannotator-inbox:end -->[ \t]*\r?$/gm;

/** `PLANNOTATOR_INBOX_NOTES=0` writes no note by itself, hides the offer and the note rows and refuses new notes; notes already written stay until switched off or uninstalled. */
export const INBOX_NOTES_ENV = "PLANNOTATOR_INBOX_NOTES";
export function inboxNotesDisabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[INBOX_NOTES_ENV]?.trim().toLowerCase();
  return value === "0" || value === "false" || value === "off" || value === "disabled";
}

export interface InboxAgentNoteRecord {
  /** The file written, as its RESOLVED path (a symlink's or a linked folder's target). */
  path: string;
  /** Plannotator created the file. */
  created: boolean;
  version: number;
  /** SHA-256 of the block as written (LF line endings). */
  block_sha256: string;
  at: string;
}

export interface InboxAgentNotesFile {
  v: 1;
  notes: Partial<Record<InboxNoteAgentId, InboxAgentNoteRecord>>;
}

export function inboxAgentNotesPath(dataDir: string): string {
  return join(inboxDir(dataDir), INBOX_AGENT_NOTES_FILE);
}

export function readInboxAgentNotes(dataDir: string): InboxAgentNotesFile {
  try {
    const parsed = JSON.parse(readFileSync(inboxAgentNotesPath(dataDir), "utf8")) as Partial<InboxAgentNotesFile>;
    if (parsed && parsed.v === 1 && parsed.notes && typeof parsed.notes === "object") {
      const notes: InboxAgentNotesFile["notes"] = {};
      for (const id of INBOX_NOTE_AGENT_IDS) {
        const record = (parsed.notes as Record<string, unknown>)[id] as InboxAgentNoteRecord | undefined;
        if (record && typeof record.path === "string" && typeof record.block_sha256 === "string") notes[id] = record;
      }
      return { v: 1, notes };
    }
  } catch {
    // Missing or damaged: the files themselves still carry the markers.
  }
  return { v: 1, notes: {} };
}

function writeInboxAgentNotes(dataDir: string, file: InboxAgentNotesFile): void {
  writeAgentFileAtomic(inboxAgentNotesPath(dataDir), `${JSON.stringify(file, null, 2)}\n`, 0o600);
}

const sha256 = (text: string) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");

/** A block exactly as some Plannotator wrote it (this version or an earlier one): Plannotator's own, untouched. */
const EARLIER_BLOCK_HASHES = new Set(INBOX_NOTE_EARLIER_BLOCKS.map(sha256));
const isPlannotatorBlock = (hash: string) => hash === sha256(INBOX_NOTE_BLOCK) || EARLIER_BLOCK_HASHES.has(hash);

/**
 * Whether a block (by hash) is the one a record owns: the block the record
 * names, or, when the record names this version, any earlier block exactly as
 * Plannotator wrote it. The second is a record ahead of its note: refreshInboxNotes
 * writes the record before the note, so a crash between the two (or a failed
 * put-back) leaves it. Only Plannotator puts a record ahead of its note, and
 * only over a block it wrote, so this never takes the person's own text; it
 * lets the next start refresh the note, and add, status and uninstall read it
 * as Plannotator's.
 */
const ownedBy = (recorded: string, hash: string) => recorded === hash || (recorded === sha256(INBOX_NOTE_BLOCK) && EARLIER_BLOCK_HASHES.has(hash));

/** Where a path leads, as far as it exists (a symlinked folder on its way included). */
function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    try {
      return join(realpathSync(dirname(path)), basename(path));
    } catch {
      return path;
    }
  }
}

// ---------------------------------------------------------------------------
// Where each note goes

interface NoteTarget {
  /** The file the note goes in, or null when there is none to add to. */
  path: string | null;
  /** Adding it creates the file. */
  create: boolean;
  /** Why there is no file. */
  reason: string | null;
}

/**
 * The instruction file name an agent's settings.json names (`context.fileName`,
 * a string or a list; the first), else `fallback`. Gemini CLI and Qwen Code
 * (a Gemini CLI fork) read it the same way.
 */
function contextFileName(settingsPath: string, fallback: string): string {
  const read = readAgentFile(settingsPath);
  if (read.kind === "file") {
    try {
      const context = (JSON.parse(stripJsonComments(read.text)) as { context?: { fileName?: unknown } }).context;
      const name = Array.isArray(context?.fileName) ? context?.fileName[0] : context?.fileName;
      if (typeof name === "string" && /^[^/\\]+$/.test(name.trim())) return name.trim();
    } catch {
      // The default.
    }
  }
  return fallback;
}

/** Claude Code's rules file: Plannotator's own (it holds only the note). */
function claudeRulesFile(e: AgentEnvironment): string {
  return join(claudeConfigDir(e), "rules", "plannotator-inbox.md");
}

/**
 * Whether Codex reads its `AGENTS.override.md` (codex-rs codex-home
 * instructions: the first of `AGENTS.override.md`, `AGENTS.md` that is a
 * regular file, can be read, and holds text once trimmed). An empty or
 * whitespace-only override is skipped, so Codex reads `AGENTS.md`; a note
 * written into it would make Codex read only the override from then on.
 * Trimmed as Rust's `str::trim` does (Unicode White_Space; a BOM is text),
 * after a lossy UTF-8 decode, as Codex reads it.
 */
function codexReadsOverride(path: string): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    // Far larger than any file of only whitespace: read as text by Codex.
    if (stat.size > 1024 * 1024) return true;
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(readFileSync(path));
    return text.replace(RUST_WHITESPACE, "") !== "";
  } catch {
    return false;
  }
}

/** Rust's `char::is_whitespace` (the Unicode White_Space property), which `str::trim` removes. */
const RUST_WHITESPACE = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g;

export function noteTarget(agent: InboxNoteAgentId, e: AgentEnvironment): NoteTarget {
  const exists = (path: string) => existsSync(path);
  switch (agent) {
    case "cursor":
      return { path: null, create: false, reason: CURSOR_NOTE_REASON };
    case "claude-code":
      return { path: claudeRulesFile(e), create: !exists(claudeRulesFile(e)), reason: null };
    case "codex": {
      const override = join(codexHome(e), "AGENTS.override.md");
      if (codexReadsOverride(override)) return { path: override, create: false, reason: null };
      const file = join(codexHome(e), "AGENTS.md");
      return { path: file, create: !exists(file), reason: null };
    }
    case "opencode": {
      const file = join(openCodeConfigDir(e), "AGENTS.md");
      if (exists(file)) return { path: file, create: false, reason: null };
      return { path: file, create: false, reason: "Creating this file would stop OpenCode 1 from reading your ~/.claude/CLAUDE.md, so Plannotator adds the note only to an AGENTS.md you already have." };
    }
    case "pi": {
      const dir = piAgentDir(e);
      for (const name of ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]) {
        if (exists(join(dir, name))) return { path: join(dir, name), create: false, reason: null };
      }
      return { path: join(dir, "AGENTS.md"), create: true, reason: null };
    }
    case "gemini": {
      const file = join(geminiDir(e), contextFileName(join(geminiDir(e), "settings.json"), "GEMINI.md"));
      return { path: file, create: !exists(file), reason: null };
    }
    case "qwen": {
      const file = join(qwenDir(e), contextFileName(join(qwenDir(e), "settings.json"), "QWEN.md"));
      return { path: file, create: !exists(file), reason: null };
    }
  }
}

// ---------------------------------------------------------------------------
// Finding the block (on the file's own text: every byte outside it stays)

type BlockFind =
  | { kind: "none" }
  | { kind: "one"; start: number; end: number; block: string }
  | { kind: "damaged" };

/** The block's span: from its start marker to the end of its end marker line (its CR included, not its LF). */
function findBlock(text: string): BlockFind {
  const starts = [...text.matchAll(START_LINE)].map((m) => m.index!);
  const ends = [...text.matchAll(END_LINE)].map((m) => ({ index: m.index!, length: m[0].replace(/\r$/, "").length }));
  if (starts.length === 0 && ends.length === 0) return { kind: "none" };
  if (starts.length !== 1 || ends.length !== 1 || ends[0]!.index < starts[0]!) return { kind: "damaged" };
  const start = starts[0]!;
  const end = ends[0]!.index + ends[0]!.length;
  return { kind: "one", start, end, block: text.slice(start, end) };
}

/** The block in the file's dominant line ending. */
function blockIn(nl: string): string {
  return INBOX_NOTE_BLOCK.replace(/\n/g, nl);
}

/**
 * `text` with the block appended at the end, after one blank line, in the
 * file's dominant ending. The file's own last byte decides how the block
 * ends, so removal can give the file back byte for byte without a record: a
 * file that ended with a line break gets the block plus a line break; one
 * that ended without (`abc`) gets the line breaks before the block and none
 * after it, so the block is the file's last bytes (stripBlock reads that).
 * Text that is only whitespace is kept as it is, with the block after it:
 * an empty one, or one ending in a line break, gets the block plus a line
 * break; one that does not end in a line break (" ", "\t") gets ONE line
 * break before the block (the start marker must begin a line) and none after
 * it, so the block is the file's last bytes there too.
 */
function appendBlock(text: string, nl: string): string {
  if (!text.trim()) return text && !/\r?\n$/.test(text) ? `${text}${nl}${blockIn(nl)}` : `${text}${blockIn(nl)}${nl}`;
  if (/\r?\n$/.test(text)) return `${text}${nl}${blockIn(nl)}${nl}`;
  return `${text}${nl}${nl}${blockIn(nl)}`;
}

/**
 * The memory sections Gemini CLI's `save_memory` and Qwen Code's global memory
 * write add to. Both find the header as the first occurrence of this text
 * anywhere in the file and add the new item at the end of the section, which
 * runs to the next `\n## `. A note after such a section would be that next
 * heading, so a remembered fact would land inside the note's markers (the note
 * would then read as the person's edit, and turning it off would take the fact
 * with it). The note goes above the section instead.
 */
const MEMORY_SECTION_HEADERS = ["## Gemini Added Memories", "## Qwen Added Memories"] as const;

/** Where the line that holds the first memory section header starts (found as the memory tools find it), or -1. */
function memorySectionLine(text: string): number {
  let at = -1;
  for (const header of MEMORY_SECTION_HEADERS) {
    const index = text.indexOf(header);
    if (index !== -1 && (at === -1 || index < at)) at = index;
  }
  return at === -1 ? -1 : text.lastIndexOf("\n", at - 1) + 1;
}

/** Whether the block at `start` sits after a memory section header (where the memory tool could write into it). */
function afterMemorySection(text: string, start: number): boolean {
  const line = memorySectionLine(text);
  return line !== -1 && line < start;
}

/**
 * `block` put above the memory section of `text` (which has one): one blank
 * line before it (none when only whitespace is before it) and its line break
 * after it, at the start of the header's line, or of the blank line right
 * above the header when there is one (so a blank line stays between the
 * block and the header). stripBlock takes it out byte for byte: the block,
 * its line break, and the blank line before it.
 */
function placeAboveMemory(text: string, block: string, nl: string): string {
  let at = memorySectionLine(text);
  // The line before the header's ends at `at - ended`; it is blank when another line break ends right before it.
  const ended = breakBefore(text, at);
  if (ended && breakBefore(text, at - ended)) at -= ended;
  const head = text.slice(0, at);
  return `${head}${head.trim() ? nl : ""}${block}${nl}${text.slice(at)}`;
}

/** `text` with the block added: above a memory section when the file has one, else at the end (appendBlock). */
function insertBlock(text: string, nl: string): string {
  return memorySectionLine(text) === -1 ? appendBlock(text, nl) : placeAboveMemory(text, blockIn(nl), nl);
}

/** The block at [start, end) moved above the memory section, as `block` (the note in the line ending given). */
function moveAboveMemory(text: string, start: number, end: number, block: string, nl: string): string {
  return placeAboveMemory(stripBlock(text, start, end), block, nl);
}

/** The length of the line break that ends just before `i` (2 for CRLF, 1 for LF), or 0. */
function breakBefore(text: string, i: number): number {
  if (i >= 2 && text[i - 2] === "\r" && text[i - 1] === "\n") return 2;
  return i >= 1 && text[i - 1] === "\n" ? 1 : 0;
}

/** `text` without the block at [start, end), its line break, and the one blank line the writer put before it. */
function stripBlock(text: string, start: number, end: number): string {
  let from = start;
  let to = end;
  if (end === text.length && start > 0) {
    // The block is the file's last bytes: appendBlock wrote it so for a file that
    // ended without a line break, after two of them (one when the text before is
    // only whitespace). Taking those gives that ending back.
    const first = breakBefore(text, from);
    if (first) {
      const head = text.slice(0, from - first);
      if (!head.trim()) return head;
      const second = breakBefore(text, from - first);
      if (second && text.slice(0, from - first - second).trim()) return text.slice(0, from - first - second);
    }
  }
  if (text.startsWith("\r\n", to)) to += 2;
  else if (text[to] === "\n") to += 1;
  // The blank line is the one line break right before the block, after the previous line's own
  // ending, whichever ending that line had ("c\n\r\n" in a mostly-CRLF file ending in a lone LF).
  // Only whitespace before the block: appendBlock wrote no blank line there, so none is taken.
  if (!text.slice(0, from).trim()) return text.slice(0, from) + text.slice(to);
  if (from >= 3 && text.slice(from - 2, from) === "\r\n" && text[from - 3] === "\n") from -= 2;
  else if (from >= 2 && text[from - 1] === "\n" && text[from - 2] === "\n") from -= 1;
  return text.slice(0, from) + text.slice(to);
}

// ---------------------------------------------------------------------------
// Status, add, remove

/** The other agents whose note record names the same resolved file. */
function sharers(agent: InboxNoteAgentId, path: string, dataDir: string): InboxNoteAgentId[] {
  const records = readInboxAgentNotes(dataDir).notes;
  return INBOX_NOTE_AGENT_IDS.filter((id) => id !== agent && records[id]?.path === path);
}

export function noteStatus(agent: InboxNoteAgentId, dataDir: string, e: AgentEnvironment): InboxAgentNoteStatus {
  const target = noteTarget(agent, e);
  if (agent === "cursor") {
    return { agent, path: null, target: null, state: "manual", create: false, created: false, reason: target.reason, shared_with: [] };
  }
  const record = readInboxAgentNotes(dataDir).notes[agent];
  const real = target.path ? resolved(target.path) : null;
  const linked = target.path && real && real !== target.path ? displayPath(real, e) : null;
  const shared = real ? sharers(agent, real, dataDir) : [];
  const base = { agent, path: displayPath(target.path, e), target: linked, create: target.create, created: record?.created === true, reason: null, shared_with: shared };
  if (!target.path) return { ...base, state: "unavailable", reason: target.reason };
  const read = readAgentFile(target.path);
  // The note this agent's record names, in a file the agent no longer reads first (Codex's
  // AGENTS.override.md appeared after the note went into AGENTS.md): still on, so Off can remove it.
  const elsewhere = (): InboxAgentNoteStatus | null => {
    if (!record || record.path === real) return null;
    const there = readAgentFile(record.path);
    if (there.kind !== "file") return null;
    const block = findBlock(there.text);
    if (block.kind !== "one") return null;
    const shownThere = displayPath(record.path, e);
    return {
      ...base,
      state: ownedBy(record.block_sha256, sha256(block.block)) ? "added" : "edited",
      reason: `The note is in ${shownThere}, which ${INBOX_AGENT_LABELS[agent]} no longer reads first; turning it off removes it there.`,
    };
  };
  if (read.kind === "missing") {
    return elsewhere() ?? (target.reason ? { ...base, state: "unavailable", reason: target.reason } : { ...base, state: "absent" });
  }
  if (read.kind === "refused") return { ...base, state: "refused", reason: read.reason };
  const found = findBlock(read.text);
  if (found.kind === "none") return elsewhere() ?? { ...base, state: "absent" };
  if (found.kind === "damaged") return { ...base, state: "damaged", reason: "the Plannotator section's markers are broken; fix or delete it by hand" };
  const hash = sha256(found.block);
  const owner = record ?? shared.map((id) => readInboxAgentNotes(dataDir).notes[id]).find(Boolean);
  const untouched = owner ? ownedBy(owner.block_sha256, hash) : isPlannotatorBlock(hash);
  // A block another agent's record owns in this shared file is on for this agent only once it has its own record.
  if (!record && shared.length > 0) return { ...base, state: "absent" };
  return { ...base, state: untouched ? "added" : "edited" };
}

export type NoteChange =
  | { ok: true; agent: InboxNoteAgentId; action: "added" | "created" | "updated" | "unchanged" | "shared" | "removed" | "deleted" | "kept-edited" | "kept-shared"; path: string }
  /** `skipped` (only with `auto`): left alone on purpose, never to be tried again by itself (read-only, hard-linked, the note pasted without markers). */
  | { ok: false; agent: InboxNoteAgentId; reason: string; path: string | null; skipped?: true };

/** How an add may write. */
export interface AddNoteOptions {
  /**
   * Written by itself (autoAddInboxNotes), with nobody's yes: the file is left alone, as the start's
   * refresh leaves it, when it is read-only (no owner write bit) or has other hard links (the atomic
   * rename would split them), and when it already holds the note pasted by hand without markers.
   */
  auto?: boolean;
  /** Tests: runs between the read and the write, to change the file under the add. */
  beforeWrite?: (target: string) => void;
}

/** The note pasted by hand without markers (as Cursor's copy, or an older prompt showed it): its heading on a line of its own. */
const UNMARKED_NOTE = /^[ \t]{0,3}#{1,6}[ \t]+Plannotator Inbox[ \t]*#*[ \t]*\r?$/m;

/** The file is still as `read` found it (the bytes and the mode, or still missing): compare before the write. */
function unchangedSince(read: AgentFileRead): boolean {
  try {
    if (read.kind === "missing") return !existsSync(read.target);
    if (read.kind !== "file") return false;
    if ((statSync(read.target).mode & 0o777) !== read.mode) return false;
    return readFileSync(read.target).equals(Buffer.from(withBom(read.text, read.bom), "utf8"));
  } catch {
    return false;
  }
}

function recordNote(dataDir: string, agent: InboxNoteAgentId, record: InboxAgentNoteRecord | null): void {
  const file = readInboxAgentNotes(dataDir);
  if (record) file.notes[agent] = record;
  else delete file.notes[agent];
  writeInboxAgentNotes(dataDir, file);
}

/** Add (or bring up to date) the note for one agent. Never overwrites a block the person edited. */
export function addInboxNote(agent: InboxNoteAgentId, dataDir: string, e: AgentEnvironment, now = new Date(), options: AddNoteOptions = {}): NoteChange {
  const target = noteTarget(agent, e);
  const shown = displayPath(target.path, e);
  if (!agentHomeAllowed(e)) return { ok: false, agent, reason: "not in a test's scratch home", path: shown };
  if (!target.path) return { ok: false, agent, reason: target.reason ?? "no file to add the note to", path: null };
  const read = readAgentFile(target.path);
  if (read.kind === "refused") return { ok: false, agent, reason: `${shown} can't be edited: ${read.reason}`, path: shown };
  if (read.kind === "missing" && (!target.create || target.reason)) {
    return { ok: false, agent, reason: target.reason ?? `${shown} does not exist`, path: shown };
  }
  const notes = readInboxAgentNotes(dataDir).notes;
  const original = read.kind === "file" ? read.text : "";
  const nl = read.kind === "file" && read.crlf ? "\r\n" : "\n";
  const found = findBlock(original);
  if (found.kind === "damaged") return { ok: false, agent, reason: `the Plannotator section in ${shown} is damaged; fix or delete it by hand`, path: shown };
  const real = resolved(target.path);
  const owner = notes[agent] ?? INBOX_NOTE_AGENT_IDS.map((id) => notes[id]).find((r) => r?.path === real);
  let next: string;
  let action: "added" | "created" | "updated" | "unchanged" | "shared";
  /** The block's hash before this add (null: there was none), for the other records naming the same file. */
  let before: string | null = null;
  if (found.kind === "one") {
    const hash = sha256(found.block);
    before = hash;
    // A note Plannotator wrote after a Gemini or Qwen memory section moves above it (the memory tool would write into it).
    const moves = afterMemorySection(original, found.start);
    if (hash === sha256(INBOX_NOTE_BLOCK)) {
      next = moves ? moveAboveMemory(original, found.start, found.end, found.block, nl) : original;
      action = moves ? "updated" : notes[agent] || !owner ? "unchanged" : "shared";
    } else if (owner ? ownedBy(owner.block_sha256, hash) : EARLIER_BLOCK_HASHES.has(hash)) {
      // An older note Plannotator wrote (its record, or with the record lost, a block exactly as an earlier version wrote it).
      next = moves ? moveAboveMemory(original, found.start, found.end, blockIn(nl), nl) : original.slice(0, found.start) + blockIn(nl) + original.slice(found.end);
      action = "updated";
    } else {
      // The person's edit: theirs to keep.
      return { ok: true, agent, action: "kept-edited", path: shown! };
    }
  } else {
    if (options.auto && UNMARKED_NOTE.test(original)) {
      return { ok: false, agent, reason: `${shown} already has the note, pasted without markers`, path: shown, skipped: true };
    }
    next = insertBlock(original, nl);
    action = read.kind === "missing" ? "created" : "added";
  }
  if (read.kind !== "file" || next !== original) {
    if (options.auto && read.kind === "file") {
      if ((read.mode & 0o200) === 0) return { ok: false, agent, reason: `${shown} is read-only`, path: shown, skipped: true };
      try {
        if (statSync(read.target).nlink > 1) return { ok: false, agent, reason: `${shown} has other hard links`, path: shown, skipped: true };
      } catch (error) {
        return { ok: false, agent, reason: `${shown} can't be read (${describeFsError(error)})`, path: shown };
      }
    }
    // Compare and write, as the refresh does: a memory Gemini saved or an edit made since the read is never lost.
    options.beforeWrite?.(read.target);
    if (!unchangedSince(read)) return { ok: false, agent, reason: `${shown} changed while the note was being added; try again`, path: shown };
    try {
      writeAgentFileAtomic(read.target, withBom(next, read.kind === "file" && read.bom), read.kind === "file" ? read.mode : 0o644);
    } catch (error) {
      return { ok: false, agent, reason: `${shown} can't be written (${describeFsError(error)})`, path: shown };
    }
  }
  const file = readInboxAgentNotes(dataDir);
  const at = resolved(read.target);
  const current = sha256(INBOX_NOTE_BLOCK);
  file.notes[agent] = {
    // The resolved path, so switching off and uninstall find the very file this wrote (a linked folder on the way).
    path: at,
    created: action === "created" || notes[agent]?.created === true || (action === "shared" && owner?.created === true),
    version: INBOX_NOTE_VERSION,
    block_sha256: current,
    at: now.toISOString(),
  };
  // The same file is another agent's note too (Pi's AGENTS.md a link to Codex's): the block they
  // recorded is the one just brought up to date, so their records follow, or that agent would read
  // Plannotator's own update as the person's edit.
  for (const id of INBOX_NOTE_AGENT_IDS) {
    const other = file.notes[id];
    if (id === agent || !other || other.path !== at || other.block_sha256 === current) continue;
    if (other.block_sha256 === before || EARLIER_BLOCK_HASHES.has(other.block_sha256)) {
      file.notes[id] = { ...other, version: INBOX_NOTE_VERSION, block_sha256: current };
    }
  }
  writeInboxAgentNotes(dataDir, file);
  return { ok: true, agent, action, path: shown! };
}

/** What refreshInboxNotes did with one agent's note. */
export interface NoteRefresh {
  agent: InboxNoteAgentId;
  /** The file its record names (resolved). */
  path: string;
  /**
   * `refreshed`: the block was an earlier version, untouched, and now is this
   * one (moved above a Gemini or Qwen memory section when it was after one);
   * `moved`: already this version, untouched, and moved above such a section;
   * `shared`: another agent's record named the same file, refreshed for
   * it; `current`: already this version; `edited`: not byte for byte a version
   * Plannotator wrote, or not the one its record names (the person's, left
   * alone); `none`: no block (the person removed it; never put back);
   * `damaged`: markers other than exactly one start line before exactly one
   * end line; `missing`: no file; `read-only`: the file has no write
   * permission for its owner; `hard-linked`: the file has other hard links
   * (a dotfiles repo's copy: a write by rename would split them); `changed`:
   * the file changed after it was read (left for the next start); `refused`:
   * not readable or writable, or agent-notes.json could not be written.
   */
  result: "refreshed" | "moved" | "shared" | "current" | "edited" | "none" | "damaged" | "missing" | "read-only" | "hard-linked" | "changed" | "refused";
}

export interface RefreshInboxNotesOptions {
  /** Test seam: runs after a file was read and its new text made, right before the write. */
  beforeWrite?: (path: string) => void;
}

/**
 * Brings every note Plannotator installed (each record in agent-notes.json)
 * up to this version, with no action by the person: run at the Inbox's start,
 * so an update reaches every installed note when the Inbox restarts onto it.
 * Deterministic and conservative, on the same marker rules as every write:
 *  - the block is found only as exactly one start line before exactly one end
 *    line (findBlock); any other markers are damaged and nothing is written;
 *  - it is replaced only when it is byte for byte (line endings aside) a block
 *    an earlier Plannotator wrote AND the one its record names (the hash):
 *    a block the person edited is never rewritten, nor a file without a record;
 *    the one exception is the retired reply sentence (RETIRED_REPLY_PHRASE),
 *    swapped in place inside an edited block, the record left as it is;
 *  - a note the person removed (no block) is never put back;
 *  - an untouched note after a Gemini or Qwen memory section's header is moved
 *    above it (the memory tool writes up to the next `## ` heading, the note's
 *    own); an edited one stays where it is;
 *  - a read-only file (no owner write bit) is left alone, and so is a file
 *    with other hard links (the atomic rename would split them);
 *  - the file is read again right before the write and left alone when it
 *    changed since it was read (another writer: never clobbered);
 *  - every byte outside the block, the block's own line ending (CRLF stays
 *    CRLF), the BOM and the mode are kept; a symlink is written at its target
 *    and stays a link; the write is atomic (a temp file, then a rename);
 *  - a file several agents' records name (Pi's AGENTS.md a link to Codex's)
 *    is written once, and every record naming it follows;
 *  - the records are written before the file and put back if the file's
 *    write fails; a record left ahead of its note (a crash between the two)
 *    still owns the earlier block (ownedBy), so the next start repairs it.
 * Never throws for one file: the rest still run. Off with PLANNOTATOR_INBOX_NOTES=0.
 */
export function refreshInboxNotes(dataDir: string, e: AgentEnvironment, options: RefreshInboxNotesOptions = {}): NoteRefresh[] {
  if (!agentHomeAllowed(e) || inboxNotesDisabled(e.env)) return [];
  const file = readInboxAgentNotes(dataDir);
  const current = sha256(INBOX_NOTE_BLOCK);
  const byPath = new Map<string, InboxNoteAgentId[]>();
  for (const agent of INBOX_NOTE_AGENT_IDS) {
    // Cursor's note is copied by hand into the app: never Plannotator's to rewrite, whatever a record says.
    if (agent === "cursor") continue;
    const record = file.notes[agent];
    if (record) byPath.set(record.path, [...(byPath.get(record.path) ?? []), agent]);
  }
  const results: NoteRefresh[] = [];
  // A record naming an earlier block follows the file to this version.
  const follow = (agents: InboxNoteAgentId[]): boolean => {
    let changed = false;
    for (const agent of agents) {
      const record = file.notes[agent]!;
      if (record.block_sha256 !== current && EARLIER_BLOCK_HASHES.has(record.block_sha256)) {
        file.notes[agent] = { ...record, version: INBOX_NOTE_VERSION, block_sha256: current };
        changed = true;
      }
    }
    return changed;
  };
  let staleRecords = false;
  for (const [path, agents] of byPath) {
    const recorded = new Set(agents.map((agent) => file.notes[agent]!.block_sha256));
    // Right before the file's write: the records first (throws, writing nothing, when they cannot be
    // written), with a way back if the file's write then fails.
    const commitRecords = (): (() => void) => {
      const saved = { ...file.notes };
      if (!follow(agents)) return () => {};
      try {
        writeInboxAgentNotes(dataDir, file);
      } catch (error) {
        file.notes = saved;
        throw error;
      }
      return () => {
        file.notes = saved;
        // Best effort: when this write fails too (or the process dies before the note's rename), the
        // record names this version over the earlier block. ownedBy reads that as Plannotator's own, so
        // the next start refreshes the note and the two agree again; add, status and uninstall meanwhile
        // treat it as the note Plannotator wrote.
        writeInboxAgentNotes(dataDir, file);
      };
    };
    let result: NoteRefresh["result"];
    try {
      result = refreshNoteFile(path, recorded, options, commitRecords);
    } catch {
      result = "refused";
    }
    // Already this version (written by an add whose record write failed, or another agent's link): the record follows.
    if (result === "current" && follow(agents)) staleRecords = true;
    agents.forEach((agent, index) => results.push({ agent, path, result: result === "refreshed" && index > 0 ? "shared" : result }));
  }
  if (staleRecords) {
    try {
      writeInboxAgentNotes(dataDir, file);
    } catch {
      // The next start tries again.
    }
  }
  return results;
}

/** The reply sentence of v1 to v6 (wait_for_reply is gone from the Inbox) and what replaces it inside a block the person edited. */
const RETIRED_REPLY_PHRASE = "otherwise call `wait_for_reply`";
const CURRENT_REPLY_PHRASE = "otherwise read the thread later with `read_thread`";

/** One file of refreshInboxNotes: its outcome, the file written for `refreshed`, and for `edited` only when the retired reply sentence was swapped. */
function refreshNoteFile(path: string, recorded: ReadonlySet<string>, options: RefreshInboxNotesOptions, commitRecords: () => () => void): NoteRefresh["result"] {
  const read = readAgentFile(path);
  if (read.kind === "missing") return "missing";
  if (read.kind === "refused") return "refused";
  const found = findBlock(read.text);
  if (found.kind === "none") return "none";
  if (found.kind === "damaged") return "damaged";
  const hash = sha256(found.block);
  // A note after a Gemini or Qwen memory section moves above it, only while it is the very block its record names.
  const moves = afterMemorySection(read.text, found.start);
  const current = hash === sha256(INBOX_NOTE_BLOCK);
  if (current && (!moves || !recorded.has(hash))) return "current";
  const untouched = (current || EARLIER_BLOCK_HASHES.has(hash)) && [...recorded].some((r) => ownedBy(r, hash));
  // The one exception for a block the person edited: the exact retired sentence inside the block is
  // swapped, every other byte and the record kept (so it still reads as edited, and a second run finds nothing).
  const patchedBlock = untouched ? null : found.block.split(RETIRED_REPLY_PHRASE).join(CURRENT_REPLY_PHRASE);
  const patching = patchedBlock !== null && patchedBlock !== found.block;
  if (!untouched && !patching) return "edited";
  const kept: NoteRefresh["result"] = untouched ? "read-only" : "edited";
  if ((read.mode & 0o200) === 0) return kept;
  if (statSync(read.target).nlink > 1) return untouched ? "hard-linked" : "edited";
  // The block's own line ending, so the bytes around it never change their ending.
  const nl = found.block.includes("\r\n") ? "\r\n" : "\n";
  const next = patching
    ? read.text.slice(0, found.start) + patchedBlock! + read.text.slice(found.end)
    : moves
      ? moveAboveMemory(read.text, found.start, found.end, blockIn(nl), nl)
      : read.text.slice(0, found.start) + blockIn(nl) + read.text.slice(found.end);
  options.beforeWrite?.(read.target);
  // Compare and write: the bytes on disk must still be the ones this read (and the mode the same).
  const before = Buffer.from(withBom(read.text, read.bom), "utf8");
  let now: Buffer;
  try {
    now = readFileSync(read.target);
    if ((statSync(read.target).mode & 0o777) !== read.mode) return "changed";
  } catch {
    return "changed";
  }
  if (!now.equals(before)) return "changed";
  if (patching) {
    // Only the file changes: the record keeps the hash of what Plannotator wrote, so the block stays the person's.
    try {
      writeAgentFileAtomic(read.target, withBom(next, read.bom), read.mode, false);
    } catch {
      return "refused";
    }
    return "edited";
  }
  let rollback: () => void;
  try {
    rollback = commitRecords();
  } catch {
    return "refused";
  }
  try {
    writeAgentFileAtomic(read.target, withBom(next, read.bom), read.mode, false);
  } catch {
    try {
      rollback();
    } catch {
      // See commitRecords.
    }
    return "refused";
  }
  return current ? "moved" : "refreshed";
}

/**
 * Remove one agent's note (as the person left it). A file Plannotator
 * created (or its own Claude Code rules file) is deleted when nothing else is
 * left. A file shared with another agent whose note is still on keeps the
 * block; only this agent's record goes.
 */
export function removeInboxNote(agent: InboxNoteAgentId, dataDir: string, e: AgentEnvironment, path?: string): NoteChange {
  if (path) return removeNoteFrom(agent, dataDir, e, path);
  // Switching off removes the note from the file the record names AND from the file the agent reads
  // now, when they differ (Codex: the note went into AGENTS.md, then AGENTS.override.md appeared).
  const record = readInboxAgentNotes(dataDir).notes[agent];
  const files: string[] = [];
  for (const file of [record?.path, noteTarget(agent, e).path, ...candidatePaths(agent, e)]) {
    if (file && !files.some((known) => resolved(known) === resolved(file))) files.push(file);
  }
  if (files.length === 0) return removeNoteFrom(agent, dataDir, e, undefined);
  const results = files.map((file) => removeNoteFrom(agent, dataDir, e, file));
  const failed = results.find((result) => !result.ok);
  if (failed) {
    // Keep the record while a copy is left, so Off (or uninstall) can try again.
    if (record) recordNote(dataDir, agent, record);
    return failed;
  }
  const order = ["deleted", "removed", "kept-shared", "unchanged"] as const;
  for (const action of order) {
    const hit = results.find((result) => result.ok && result.action === action);
    if (hit) return hit;
  }
  return results[0]!;
}

function removeNoteFrom(agent: InboxNoteAgentId, dataDir: string, e: AgentEnvironment, path: string | undefined): NoteChange {
  const notes = readInboxAgentNotes(dataDir).notes;
  const record = notes[agent];
  const file = path ?? record?.path ?? noteTarget(agent, e).path;
  const shown = displayPath(file, e);
  if (!agentHomeAllowed(e)) return { ok: false, agent, reason: "not in a test's scratch home", path: shown };
  if (!file) return { ok: true, agent, action: "unchanged", path: "" };
  const real = resolved(file);
  if (sharers(agent, real, dataDir).length > 0) {
    recordNote(dataDir, agent, null);
    return { ok: true, agent, action: "kept-shared", path: shown! };
  }
  const read = readAgentFile(file);
  if (read.kind === "missing") {
    recordNote(dataDir, agent, null);
    return { ok: true, agent, action: "unchanged", path: shown! };
  }
  if (read.kind === "refused") return { ok: false, agent, reason: `${shown} can't be edited: ${read.reason}`, path: shown };
  const found = findBlock(read.text);
  if (found.kind === "damaged") return { ok: false, agent, reason: `the Plannotator section in ${shown} is damaged; fix or delete it by hand`, path: shown };
  if (found.kind === "none") {
    recordNote(dataDir, agent, null);
    return { ok: true, agent, action: "unchanged", path: shown! };
  }
  const rest = stripBlock(read.text, found.start, found.end);
  const created = (record?.created && record.path === resolved(read.target)) || resolved(read.target) === resolved(claudeRulesFile(e));
  try {
    if (created && !rest.trim()) {
      rmSync(read.target, { force: true });
      recordNote(dataDir, agent, null);
      return { ok: true, agent, action: "deleted", path: shown! };
    }
    writeAgentFileAtomic(read.target, withBom(rest, read.bom), read.mode);
  } catch (error) {
    return { ok: false, agent, reason: `${shown} can't be written (${describeFsError(error)})`, path: shown };
  }
  recordNote(dataDir, agent, null);
  return { ok: true, agent, action: "removed", path: shown! };
}

/** Every file a note could be in for `agent` (for the uninstall scan when the record is gone). */
function candidatePaths(agent: InboxNoteAgentId, e: AgentEnvironment): string[] {
  switch (agent) {
    case "cursor":
      return [];
    case "codex":
      return [join(codexHome(e), "AGENTS.override.md"), join(codexHome(e), "AGENTS.md")];
    case "pi":
      return ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"].map((name) => join(piAgentDir(e), name));
    case "opencode":
      return [join(openCodeConfigDir(e), "AGENTS.md")];
    default: {
      const target = noteTarget(agent, e);
      return target.path ? [target.path] : [];
    }
  }
}

export interface NoteRemovalItem {
  agent: InboxNoteAgentId;
  path: string;
  describe: string;
  apply: () => NoteChange;
}

export interface NoteRemovalPlan {
  items: NoteRemovalItem[];
  /** Files whose Plannotator section is damaged: left, and named. */
  skipped: string[];
}

/** What uninstall removes: every recorded note, then any file that still holds our markers; damaged sections are named, never touched. */
export function planInboxNoteRemoval(dataDir: string, e: AgentEnvironment, labels: Record<InboxNoteAgentId, string>): NoteRemovalPlan {
  if (!agentHomeAllowed(e)) return { items: [], skipped: [] };
  const records = readInboxAgentNotes(dataDir).notes;
  const items: NoteRemovalItem[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const agent of INBOX_NOTE_AGENT_IDS) {
    const paths = [records[agent]?.path, ...candidatePaths(agent, e)].filter((p): p is string => !!p);
    for (const path of paths) {
      const read = readAgentFile(path);
      const real = resolved(read.kind === "missing" ? path : read.target);
      if (read.kind !== "file" || seen.has(real)) continue;
      const found = findBlock(read.text);
      if (found.kind === "none") continue;
      seen.add(real);
      const shown = displayPath(path, e)!;
      if (found.kind === "damaged") {
        skipped.push(`the Plannotator section in ${shown} is damaged, so uninstall left it; fix or delete it by hand`);
        continue;
      }
      const owners = INBOX_NOTE_AGENT_IDS.filter((id) => records[id]?.path === real);
      const record = owners.map((id) => records[id]).find(Boolean);
      const edited = record ? !ownedBy(record.block_sha256, sha256(found.block)) : !isPlannotatorBlock(sha256(found.block));
      const created = record?.created === true || real === resolved(claudeRulesFile(e));
      const how = created ? "created by Plannotator: file removed if empty" : "marked section only";
      items.push({
        agent,
        path: shown,
        describe: `Note for ${labels[agent]} (${shown}, ${how}${edited ? "; you edited it" : ""})`,
        apply: () => {
          // A shared file: drop the other owners' records first, so the section goes once.
          for (const other of owners) if (other !== agent) recordNote(dataDir, other, null);
          return removeInboxNote(agent, dataDir, e, path);
        },
      });
    }
  }
  return { items, skipped };
}

// ---------------------------------------------------------------------------
// Asked once per agent (the approved "inbox-agent-note-dialog" design, which
// amends decision 5: the window's question is asked once PER AGENT)

/** A valid list of note agents, or null when `value` is not a list. Unknown ids are dropped. */
function noteAgentIds(value: unknown): InboxNoteAgentId[] | null {
  if (!Array.isArray(value)) return null;
  return INBOX_NOTE_AGENT_IDS.filter((id) => value.includes(id));
}

/**
 * The agents that can take a note now (the window's candidates): found,
 * reaching the Inbox, no note yet, a file to put it in, and not failed by the
 * last connecting run. The same rule as `noteCandidates` in packages/inbox/agents.ts.
 */
export async function noteCandidateIds(options: ConnectOptions): Promise<InboxNoteAgentId[]> {
  const e = options.environment;
  const failed = new Set(readInboxAgents(options.dataDir).last_report?.failed.map((f) => f.agent) ?? []);
  const out: InboxNoteAgentId[] = [];
  for (const id of INBOX_NOTE_AGENT_IDS) {
    if (failed.has(id) || !agentSpec(id).detect(e)) continue;
    const state = noteStatus(id, options.dataDir, e).state;
    if (state !== "absent" && state !== "manual") continue;
    if ((await inboxAgentReach(id, options)).on) out.push(id);
  }
  return out;
}

/**
 * The agents that have the note, however it got there: a record in
 * `inbox/agent-notes.json` (Plannotator wrote it), or a found agent whose
 * file holds the section now. The person said yes to these (or wrote it
 * themselves), so they count as asked: removing the note later in Settings
 * never brings the question back.
 */
export function noteHolderIds(options: Pick<ConnectOptions, "dataDir" | "environment">): InboxNoteAgentId[] {
  const records = readInboxAgentNotes(options.dataDir).notes;
  return INBOX_NOTE_AGENT_IDS.filter((id) => {
    if (records[id]) return true;
    if (id === "cursor" || !agentSpec(id).detect(options.environment)) return false;
    const state = noteStatus(id, options.dataDir, options.environment).state;
    return state === "added" || state === "edited";
  });
}

/**
 * The agents the note question has been asked about (config.json
 * `inboxAgentNotes.asked`), always including every agent that has the note
 * (`noteHolderIds`; saved the first time one is missing). An Inbox of
 * 0.28.18 or older recorded only `offered: true` (asked once, about every
 * agent that could take a note then): the first read here turns that into
 * the agents that can take a note NOW plus the agents that have it, and
 * saves it, so those are never asked again while an agent that becomes a
 * candidate later is asked once, for itself.
 */
export async function notesAsked(options: ConnectOptions): Promise<InboxNoteAgentId[]> {
  const saved = loadConfig().inboxAgentNotes;
  const recorded = noteAgentIds(saved?.asked);
  const holders = noteHolderIds(options);
  const base = recorded ?? (saved?.offered === true ? await noteCandidateIds(options) : []);
  const asked = INBOX_NOTE_AGENT_IDS.filter((id) => base.includes(id) || holders.includes(id));
  // Saved when it differs from the file: the 0.28.18 read, or a note that came another way (Settings, an older Inbox, by hand).
  if (!recorded || asked.length !== recorded.length) {
    if (recorded || asked.length > 0) saveConfig({ inboxAgentNotes: { ...(loadConfig().inboxAgentNotes ?? {}), asked } });
  }
  return asked;
}

/** Record that these agents were asked (they are never asked again). `offered` stays true for an older Inbox reading the same config. */
export async function markNotesAsked(ids: readonly InboxNoteAgentId[], options: ConnectOptions): Promise<void> {
  if (ids.length === 0) return;
  const before = await notesAsked(options);
  const asked = INBOX_NOTE_AGENT_IDS.filter((id) => before.includes(id) || ids.includes(id));
  saveConfig({ inboxAgentNotes: { ...(loadConfig().inboxAgentNotes ?? {}), offered: true, asked } });
}

// ---------------------------------------------------------------------------
// Written by itself (approval "inbox-agent-note-auto", which superseded the
// one-time dialog for the agents proven to load the note)

/**
 * Write the note for every connected agent proven to load it
 * (INBOX_NOTE_AUTO_AGENT_IDS) that can take one now (`noteCandidateIds`: found,
 * reaching the Inbox, no note yet, a file to put it in, not failed by the last
 * connecting run) and was never asked about it (`notesAsked`: an old dialog's
 * Add, Not now or Don't add a note, `--notes`, a Settings switch on or off, or
 * a note already written). Each one written is recorded as asked, so it is
 * written once: a note the person removes, by hand or in Settings, never comes
 * back by itself. One that cannot be written is left unasked and tried again
 * next time, said nowhere (Settings → Agents shows its state). Nothing with
 * PLANNOTATOR_INBOX_NOTES=0, or in a test whose home is not a scratch folder.
 * Returns the notes written (paths with `~`).
 */
export async function autoAddInboxNotes(options: ConnectOptions): Promise<InboxNoteAutoAdd[]> {
  const e = options.environment;
  if (!agentHomeAllowed(e) || inboxNotesDisabled(e.env)) return [];
  const asked = new Set(await notesAsked(options));
  const candidates = (await noteCandidateIds(options)).filter((id) => INBOX_NOTE_AUTO_AGENT_IDS.includes(id) && !asked.has(id));
  const written: InboxNoteAgentId[] = [];
  const added: InboxNoteAutoAdd[] = [];
  for (const agent of candidates) {
    const change = addInboxNote(agent, options.dataDir, e, options.now?.(), { auto: true });
    // Left alone on purpose (read-only, hard-linked, pasted without markers): answered, never tried again by itself.
    if (!change.ok && change.skipped) written.push(agent);
    if (!change.ok || change.action === "kept-edited") continue;
    written.push(agent);
    if (change.action !== "unchanged") added.push({ agent, path: change.path });
  }
  await markNotesAsked(written, options);
  if (added.length > 0) {
    // Said once in the window (its quiet line); a later run's adds join the ones not said yet.
    const saved = loadConfig().inboxAgentNotes ?? {};
    const unsaid = (saved.auto ?? []).filter((entry) => !added.some((next) => next.agent === entry.agent));
    saveConfig({ inboxAgentNotes: { ...saved, auto: [...unsaid, ...added] } });
  }
  return added;
}

/** The notes written by themselves that the window has not said yet. */
export function unsaidAutoNotes(): InboxNoteAutoAdd[] {
  const auto = loadConfig().inboxAgentNotes?.auto;
  if (!Array.isArray(auto)) return [];
  return auto.filter(
    (entry): entry is InboxNoteAutoAdd =>
      !!entry && typeof entry.path === "string" && (INBOX_NOTE_AGENT_IDS as readonly string[]).includes(entry.agent),
  );
}

/**
 * The window said them (POST /api/inbox/agents/seen): the notes its line showed, so one written by a pass
 * that ended after the window read the agents is still said next time. `shown` absent (an older window): all.
 */
export function markAutoNotesSaid(shown?: readonly InboxNoteAutoAdd[]): void {
  const saved = loadConfig().inboxAgentNotes;
  if (!saved?.auto) return;
  const { auto, ...rest } = saved;
  const left = shown ? auto.filter((entry) => !shown.some((said) => said.agent === entry.agent && said.path === entry.path)) : [];
  saveConfig({ inboxAgentNotes: left.length > 0 ? { ...rest, auto: left } : rest });
}
