/**
 * The Inbox note in each agent's own instructions file (the approved
 * "inbox-agent-awareness" design, decision 5; HOOKS.md section 6.2).
 *
 * Written only with the person's yes: the window's one-time question, a
 * Settings switch, or `plannotator inbox --notes <ids>` (the install prompt,
 * after the person agreed in chat). Never by a start, the shim or a
 * connection.
 *
 * Where (honouring CLAUDE_CONFIG_DIR, CODEX_HOME, OPENCODE_CONFIG_DIR /
 * XDG_CONFIG_HOME, PI_CODING_AGENT_DIR and Gemini's `context.fileName`):
 *  - Claude Code: `~/.claude/rules/plannotator-inbox.md`, a file Plannotator owns.
 *  - Codex: `AGENTS.override.md` when it exists, else `AGENTS.md` (created only without an override).
 *  - OpenCode: `~/.config/opencode/AGENTS.md`, ONLY when it exists: creating it
 *    would stop OpenCode 1 reading the person's `~/.claude/CLAUDE.md`.
 *  - Pi: the first that exists of `AGENTS.override.md`, `AGENTS.md`,
 *    `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` (Pi reads only one); `AGENTS.md`
 *    created only when none does.
 *  - Gemini CLI: `~/.gemini/<context.fileName>`, default `GEMINI.md`.
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
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
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
  openCodeConfigDir,
  inboxAgentReach,
  piAgentDir,
  readInboxAgents,
  type AgentEnvironment,
  type ConnectOptions,
} from "./inbox-agents";

export const INBOX_NOTE_VERSION = 1;
export const INBOX_NOTE_START = `<!-- plannotator-inbox:start v${INBOX_NOTE_VERSION} · added by Plannotator. Remove it in the Inbox's Settings or with \`plannotator uninstall\` -->`;
export const INBOX_NOTE_END = "<!-- plannotator-inbox:end -->";

/** The note (DESIGN.md section 2.3): true with or without the tool, so a session without it is not misled. */
export const INBOX_NOTE_BODY = [
  "## Plannotator Inbox",
  "",
  "The person keeps a Plannotator Inbox on this computer: a window where they read what agents send and answer when they can.",
  "If you have a `plannotator_inbox` tool or a `plannotator-inbox` MCP server, use its `send_message` when the person isn't here to answer in this chat: to ask a decision only they can make (as a `:::question` block), or to hand over finished long work (put the files to read in `attachments`). Then keep working.",
  "Their reply comes back to this session by itself where your agent supports that; otherwise call `wait_for_reply`. When they are here, ask in this chat instead.",
].join("\n");

export const INBOX_NOTE_BLOCK = `${INBOX_NOTE_START}\n${INBOX_NOTE_BODY}\n${INBOX_NOTE_END}`;

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

/** Gemini's instruction file name (`context.fileName`, a string or a list; the first), default GEMINI.md. */
function geminiContextFile(e: AgentEnvironment): string {
  const read = readAgentFile(join(geminiDir(e), "settings.json"));
  if (read.kind === "file") {
    try {
      const context = (JSON.parse(stripJsonComments(read.text)) as { context?: { fileName?: unknown } }).context;
      const name = Array.isArray(context?.fileName) ? context?.fileName[0] : context?.fileName;
      if (typeof name === "string" && /^[^/\\]+$/.test(name.trim())) return name.trim();
    } catch {
      // The default.
    }
  }
  return "GEMINI.md";
}

/** Claude Code's rules file: Plannotator's own (it holds only the note). */
function claudeRulesFile(e: AgentEnvironment): string {
  return join(claudeConfigDir(e), "rules", "plannotator-inbox.md");
}

export function noteTarget(agent: InboxNoteAgentId, e: AgentEnvironment): NoteTarget {
  const exists = (path: string) => existsSync(path);
  switch (agent) {
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
      const file = join(geminiDir(e), geminiContextFile(e));
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
      state: sha256(block.block) === record.block_sha256 ? "added" : "edited",
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
  const untouched = owner ? owner.block_sha256 === hash : hash === sha256(INBOX_NOTE_BLOCK);
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
  if (found.kind === "one") {
    const hash = sha256(found.block);
    if (hash === sha256(INBOX_NOTE_BLOCK)) {
      next = original;
      action = notes[agent] || !owner ? "unchanged" : "shared";
    } else if (owner && owner.block_sha256 === hash) {
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
  recordNote(dataDir, agent, {
    // The resolved path, so switching off and uninstall find the very file this wrote (a linked folder on the way).
    path: resolved(read.target),
    created: action === "created" || notes[agent]?.created === true || (action === "shared" && owner?.created === true),
    version: INBOX_NOTE_VERSION,
    block_sha256: sha256(INBOX_NOTE_BLOCK),
    at: now.toISOString(),
  });
  return { ok: true, agent, action, path: shown! };
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
      const edited = sha256(found.block) !== (record?.block_sha256 ?? sha256(INBOX_NOTE_BLOCK));
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
    if (noteStatus(id, options.dataDir, e).state !== "absent") continue;
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
    if (!agentSpec(id).detect(options.environment)) return false;
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
