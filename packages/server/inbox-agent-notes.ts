/**
 * The Inbox note in each agent's own instructions file (the approved
 * "inbox-agent-awareness" design, decision 5; HOOKS.md section 6.2).
 *
 * Written only with the person's yes: the window's one-time question, a
 * Settings switch, or `plannotator inbox --notes <ids>` (the install prompt,
 * after the person agreed in chat). Never added by a start, the shim or a
 * connection. A note already installed is brought up to the current version
 * by the Inbox's start, only while it is byte for byte an earlier version
 * Plannotator wrote (refreshInboxNotes).
 *
 * Where (honouring CLAUDE_CONFIG_DIR, CODEX_HOME, OPENCODE_CONFIG_DIR /
 * XDG_CONFIG_HOME, PI_CODING_AGENT_DIR, QWEN_HOME and Gemini's and Qwen's
 * `context.fileName`):
 *  - Claude Code: `~/.claude/rules/plannotator-inbox.md`, a file Plannotator owns.
 *  - Codex: `AGENTS.override.md` when it exists, else `AGENTS.md` (created only without an override).
 *  - OpenCode: `~/.config/opencode/AGENTS.md`, ONLY when it exists: creating it
 *    would stop OpenCode 1 reading the person's `~/.claude/CLAUDE.md`.
 *  - Pi: the first that exists of `AGENTS.override.md`, `AGENTS.md`,
 *    `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` (Pi reads only one); `AGENTS.md`
 *    created only when none does.
 *  - Gemini CLI: `~/.gemini/<context.fileName>`, default `GEMINI.md`.
 *  - Qwen Code: `$QWEN_HOME/<context.fileName>` (default folder `~/.qwen`), default `QWEN.md`.
 *  - Cursor: copied by hand into Customize → Rules in the app; Cursor documents no global rules file, so nothing is written.
 *
 * The block sits between markers at the END of the file. Exactly one start
 * before exactly one end: the block is ours; none: appended; anything else:
 * damaged, nothing is written. `inbox/agent-notes.json` keeps each block's
 * SHA-256, so a block the person edited is theirs and never overwritten (a
 * newer note version is written only over an untouched block). Writes keep
 * line endings and mode, follow symlinks, are atomic, and are skipped when
 * nothing changes (agent-files.ts).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  INBOX_AGENT_LABELS,
  INBOX_NOTE_AGENT_IDS,
  type InboxAgentNoteStatus,
  type InboxNoteAgentId,
} from "@plannotator/core/inbox-types";
import { loadConfig, saveConfig } from "@plannotator/shared/config";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import { describeFsError, readAgentFile, stripJsonComments, withBom, writeAgentFileAtomic } from "./agent-files";
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
 * 0.28.34 and is on users' disks. An earlier block Plannotator wrote is brought
 * up to date at the Inbox's next start (refreshInboxNotes) or when the note
 * is added again (`--notes`, the Settings switch); a block the person edited
 * never is. Every version's text is frozen as literals and its block's hash
 * pinned (inbox-agent-notes-refresh.test.ts): a released note's bytes never
 * change without a new version, or the notes on disk would read as edited.
 */
export const INBOX_NOTE_VERSION = 4;
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

/**
 * The note (DESIGN.md section 2.3): true with or without the tool, so a
 * session without it is not misled. Loaded in every session of the agent, so
 * every line earns its place. v3 (the owner, 2026-10-27): chat or Inbox is
 * never a guess at whether the person is here; a decision in the Inbox stays
 * there, the chat only says what waits. v4 (the owner, 2026-10-27): be
 * proactive in the Inbox, the one wording of INBOX_FOLLOW_THROUGH_RULE
 * (kept a literal here; tests/inbox-guidance-parity.test.ts holds it equal).
 */
export const INBOX_NOTE_BODY = [
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

/** Cursor keeps its global rules in the app, so its note is copied by hand (the body only, never the markers). */
export const CURSOR_NOTE_REASON = "Cursor keeps its rules in the app: copy the note into Customize → Rules yourself. Plannotator can't see, update or remove that copy.";

export const INBOX_NOTE_BLOCK = `${INBOX_NOTE_START}\n${INBOX_NOTE_BODY}\n${INBOX_NOTE_END}`;

/** Every block an earlier Plannotator wrote, untouched (LF): read as Plannotator's own when no record names it. */
export const INBOX_NOTE_EARLIER_BLOCKS: readonly string[] = [
  `${noteStart(1)}\n${INBOX_NOTE_BODY_V1}\n${INBOX_NOTE_END}`,
  `${noteStart(2)}\n${INBOX_NOTE_BODY_V2}\n${INBOX_NOTE_END}`,
  `${noteStart(3)}\n${INBOX_NOTE_BODY_V3}\n${INBOX_NOTE_END}`,
];

export const INBOX_AGENT_NOTES_FILE = "agent-notes.json";

/** Any version's start marker, and the end marker, each on its own line (a CRLF line too). */
const START_LINE = /^<!-- plannotator-inbox:start\b[^\r\n]*-->[ \t]*\r?$/gm;
const END_LINE = /^<!-- plannotator-inbox:end -->[ \t]*\r?$/gm;

/** `PLANNOTATOR_INBOX_NOTES=0` hides the offer and the note rows and refuses new notes; notes already written stay until switched off or uninstalled. */
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

export function noteTarget(agent: InboxNoteAgentId, e: AgentEnvironment): NoteTarget {
  const exists = (path: string) => existsSync(path);
  switch (agent) {
    case "cursor":
      return { path: null, create: false, reason: CURSOR_NOTE_REASON };
    case "claude-code":
      return { path: claudeRulesFile(e), create: !exists(claudeRulesFile(e)), reason: null };
    case "codex": {
      const override = join(codexHome(e), "AGENTS.override.md");
      if (exists(override)) return { path: override, create: false, reason: null };
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
  | { ok: false; agent: InboxNoteAgentId; reason: string; path: string | null };

function recordNote(dataDir: string, agent: InboxNoteAgentId, record: InboxAgentNoteRecord | null): void {
  const file = readInboxAgentNotes(dataDir);
  if (record) file.notes[agent] = record;
  else delete file.notes[agent];
  writeInboxAgentNotes(dataDir, file);
}

/** Add (or bring up to date) the note for one agent. Never overwrites a block the person edited. */
export function addInboxNote(agent: InboxNoteAgentId, dataDir: string, e: AgentEnvironment, now = new Date()): NoteChange {
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
    if (hash === sha256(INBOX_NOTE_BLOCK)) {
      next = original;
      action = notes[agent] || !owner ? "unchanged" : "shared";
    } else if (owner ? ownedBy(owner.block_sha256, hash) : EARLIER_BLOCK_HASHES.has(hash)) {
      // An older note Plannotator wrote (its record, or with the record lost, a block exactly as an earlier version wrote it).
      next = original.slice(0, found.start) + blockIn(nl) + original.slice(found.end);
      action = "updated";
    } else {
      // The person's edit: theirs to keep.
      return { ok: true, agent, action: "kept-edited", path: shown! };
    }
  } else {
    next = appendBlock(original, nl);
    action = read.kind === "missing" ? "created" : "added";
  }
  if (read.kind !== "file" || next !== original) {
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
   * one; `shared`: another agent's record named the same file, refreshed for
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
  result: "refreshed" | "shared" | "current" | "edited" | "none" | "damaged" | "missing" | "read-only" | "hard-linked" | "changed" | "refused";
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
 *    a block the person edited is never touched, nor a file without a record;
 *  - a note the person removed (no block) is never put back;
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

/** One file of refreshInboxNotes: its outcome, the file written only for `refreshed`. */
function refreshNoteFile(path: string, recorded: ReadonlySet<string>, options: RefreshInboxNotesOptions, commitRecords: () => () => void): NoteRefresh["result"] {
  const read = readAgentFile(path);
  if (read.kind === "missing") return "missing";
  if (read.kind === "refused") return "refused";
  const found = findBlock(read.text);
  if (found.kind === "none") return "none";
  if (found.kind === "damaged") return "damaged";
  const hash = sha256(found.block);
  if (hash === sha256(INBOX_NOTE_BLOCK)) return "current";
  if (!EARLIER_BLOCK_HASHES.has(hash) || ![...recorded].some((r) => ownedBy(r, hash))) return "edited";
  if ((read.mode & 0o200) === 0) return "read-only";
  if (statSync(read.target).nlink > 1) return "hard-linked";
  // The block's own line ending, so the bytes around it never change their ending.
  const nl = found.block.includes("\r\n") ? "\r\n" : "\n";
  const next = read.text.slice(0, found.start) + blockIn(nl) + read.text.slice(found.end);
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
  return "refreshed";
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
