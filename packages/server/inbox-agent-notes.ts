/**
 * The Inbox note in each agent's own instructions file, between markers at the END of the file (or right above a Gemini CLI / Qwen Code memory section, whose memory tools append up to the next `## ` heading).
 * Exactly one start before exactly one end: the block is ours; none: appended; anything else: damaged, nothing is written. `inbox/agent-notes.json` keeps each block's SHA-256, so a block the person edited is theirs and never overwritten.
 * OpenCode's AGENTS.md only when it exists: creating it would stop OpenCode 1 reading the person's `~/.claude/CLAUDE.md`. Writes keep line endings and mode, follow symlinks, are atomic, and are skipped when nothing changes (agent-files.ts).
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
 * Every released version's text is frozen as literals and its block's hash pinned (inbox-agent-notes-refresh.test.ts): a released note's bytes never change without a new version, or notes on disk would read as edited.
 * An earlier untouched block is brought up to date at the Inbox's next start or when the note is added again; a block the person edited never is (bar the one retired sentence).
 */
export const INBOX_NOTE_VERSION = 9;
const noteStart = (version: number) =>
  `<!-- plannotator-inbox:start v${version} · added by Plannotator. Remove it in the Inbox's Settings or with \`plannotator uninstall\` -->`;
export const INBOX_NOTE_START = noteStart(INBOX_NOTE_VERSION);
export const INBOX_NOTE_END = "<!-- plannotator-inbox:end -->";

/** v1's body, frozen as literals so such a block still reads as Plannotator's own. */
const INBOX_NOTE_BODY_V1 = [
  "## Plannotator Inbox",
  "",
  "The person keeps a Plannotator Inbox on this computer: a window where they read what agents send and answer when they can.",
  "If you have a `plannotator_inbox` tool or a `plannotator-inbox` MCP server, use its `send_message` when the person isn't here to answer in this chat: to ask a decision only they can make (as a `:::question` block), or to hand over finished long work (put the files to read in `attachments`). Then keep working.",
  "Their reply comes back to this session by itself where your agent supports that; otherwise call `wait_for_reply`. When they are here, ask in this chat instead.",
].join("\n");

/** v2's body, frozen as literals so such a block still reads as Plannotator's own. */
const INBOX_NOTE_BODY_V2 = [
  INBOX_NOTE_BODY_V1,
  "Before reply_to into a thread you have not read in this context window, call read_thread with no id and match the subject.",
  'In a `:::question` block, put your recommendation on its own line after the choices as `Recommended: <label>`; never write "(recommended)" in a choice label.',
].join("\n");

/** v3's body, frozen as literals so such a block still reads as Plannotator's own. */
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

/** v4's body, frozen as literals so such a block still reads as Plannotator's own. */
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

/** v5's body, frozen as literals so such a block still reads as Plannotator's own. */
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

/** v6's body, frozen as literals so such a block still reads as Plannotator's own. */
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

/** v7's body, frozen as literals so such a block still reads as Plannotator's own. */
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

/** v8's body, frozen as literals so such a block still reads as Plannotator's own. */
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
 * The note: true with or without the tool, so a session without it is not misled. Loaded in every session of the agent, so every line earns its place.
 * INBOX_FOLLOW_THROUGH_RULE and INBOX_THREAD_RULE are kept as literals here; tests/inbox-guidance-parity.test.ts holds them equal.
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

const START_LINE = /^<!-- plannotator-inbox:start\b[^\r\n]*-->[ \t]*\r?$/gm;
const END_LINE = /^<!-- plannotator-inbox:end -->[ \t]*\r?$/gm;

export const INBOX_NOTES_ENV = "PLANNOTATOR_INBOX_NOTES";
export function inboxNotesDisabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[INBOX_NOTES_ENV]?.trim().toLowerCase();
  return value === "0" || value === "false" || value === "off" || value === "disabled";
}

export interface InboxAgentNoteRecord {
  path: string;
  created: boolean;
  version: number;
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

const EARLIER_BLOCK_HASHES = new Set(INBOX_NOTE_EARLIER_BLOCKS.map(sha256));
const isPlannotatorBlock = (hash: string) => hash === sha256(INBOX_NOTE_BLOCK) || EARLIER_BLOCK_HASHES.has(hash);

/** Whether a block (by hash) is the one a record owns: the block the record names, or, when the record names this version, any earlier block exactly as Plannotator wrote it. The second is a record ahead of its note: refreshInboxNotes writes the record before the note, so a crash between the two leaves it. Only Plannotator puts a record ahead of its note, and only over a block it wrote. */
const ownedBy = (recorded: string, hash: string) => recorded === hash || (recorded === sha256(INBOX_NOTE_BLOCK) && EARLIER_BLOCK_HASHES.has(hash));

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

interface NoteTarget {
  path: string | null;
  create: boolean;
  reason: string | null;
}

/** The instruction file name an agent's settings.json names (`context.fileName`, a string or a list; the first), else `fallback`. */
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

function claudeRulesFile(e: AgentEnvironment): string {
  return join(claudeConfigDir(e), "rules", "plannotator-inbox.md");
}

/** Whether Codex reads its `AGENTS.override.md`: only when it is a regular file, readable, and holds text once trimmed (as Rust's `str::trim`, a BOM is text) after a lossy UTF-8 decode. A note written into an empty override would make Codex read only the override from then on. */
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

type BlockFind =
  | { kind: "none" }
  | { kind: "one"; start: number; end: number; block: string }
  | { kind: "damaged" };

function findBlock(text: string): BlockFind {
  const starts = [...text.matchAll(START_LINE)].map((m) => m.index!);
  const ends = [...text.matchAll(END_LINE)].map((m) => ({ index: m.index!, length: m[0].replace(/\r$/, "").length }));
  if (starts.length === 0 && ends.length === 0) return { kind: "none" };
  if (starts.length !== 1 || ends.length !== 1 || ends[0]!.index < starts[0]!) return { kind: "damaged" };
  const start = starts[0]!;
  const end = ends[0]!.index + ends[0]!.length;
  return { kind: "one", start, end, block: text.slice(start, end) };
}

function blockIn(nl: string): string {
  return INBOX_NOTE_BLOCK.replace(/\n/g, nl);
}

/** `text` with the block appended at the end, after one blank line. The file's own last byte decides how the block ends, so removal can give the file back byte for byte without a record (stripBlock reads that); the start marker must begin a line. */
function appendBlock(text: string, nl: string): string {
  if (!text.trim()) return text && !/\r?\n$/.test(text) ? `${text}${nl}${blockIn(nl)}` : `${text}${blockIn(nl)}${nl}`;
  if (/\r?\n$/.test(text)) return `${text}${nl}${blockIn(nl)}${nl}`;
  return `${text}${nl}${nl}${blockIn(nl)}`;
}

/**
 * The memory sections Gemini CLI's `save_memory` and Qwen Code's global memory write add to: new items go at the end of the section, which runs to the next `
 * ## `. A note after such a section would be that next heading, so a fact would land inside the note's markers; the note goes above the section instead.
 */
const MEMORY_SECTION_HEADERS = ["## Gemini Added Memories", "## Qwen Added Memories"] as const;

function memorySectionLine(text: string): number {
  let at = -1;
  for (const header of MEMORY_SECTION_HEADERS) {
    const index = text.indexOf(header);
    if (index !== -1 && (at === -1 || index < at)) at = index;
  }
  return at === -1 ? -1 : text.lastIndexOf("\n", at - 1) + 1;
}

function afterMemorySection(text: string, start: number): boolean {
  const line = memorySectionLine(text);
  return line !== -1 && line < start;
}

/** `block` put above the memory section of `text`, at the start of the header's line (or of the blank line right above it). stripBlock takes it out byte for byte. */
function placeAboveMemory(text: string, block: string, nl: string): string {
  let at = memorySectionLine(text);
  const ended = breakBefore(text, at);
  if (ended && breakBefore(text, at - ended)) at -= ended;
  const head = text.slice(0, at);
  return `${head}${head.trim() ? nl : ""}${block}${nl}${text.slice(at)}`;
}

function insertBlock(text: string, nl: string): string {
  return memorySectionLine(text) === -1 ? appendBlock(text, nl) : placeAboveMemory(text, blockIn(nl), nl);
}

function moveAboveMemory(text: string, start: number, end: number, block: string, nl: string): string {
  return placeAboveMemory(stripBlock(text, start, end), block, nl);
}

function breakBefore(text: string, i: number): number {
  if (i >= 2 && text[i - 2] === "\r" && text[i - 1] === "\n") return 2;
  return i >= 1 && text[i - 1] === "\n" ? 1 : 0;
}

function stripBlock(text: string, start: number, end: number): string {
  let from = start;
  let to = end;
  if (end === text.length && start > 0) {
    // The block is the file's last bytes: appendBlock wrote it so for a file that ended without a line break.
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
  // The blank line is the one line break right before the block, whichever ending the previous line had.
  if (!text.slice(0, from).trim()) return text.slice(0, from) + text.slice(to);
  if (from >= 3 && text.slice(from - 2, from) === "\r\n" && text[from - 3] === "\n") from -= 2;
  else if (from >= 2 && text[from - 1] === "\n" && text[from - 2] === "\n") from -= 1;
  return text.slice(0, from) + text.slice(to);
}

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
  // A note in a file the agent no longer reads first (Codex's AGENTS.override.md appeared after the note went into AGENTS.md) is still on, so Off can remove it.
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

export interface AddNoteOptions {
  /** Written by itself, with nobody's yes: the file is left alone when it is read-only, has other hard links (the atomic rename would split them), or already holds the note pasted by hand without markers. */
  auto?: boolean;
  beforeWrite?: (target: string) => void;
}

const UNMARKED_NOTE = /^[ \t]{0,3}#{1,6}[ \t]+Plannotator Inbox[ \t]*#*[ \t]*\r?$/m;

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
  let before: string | null = null;
  if (found.kind === "one") {
    const hash = sha256(found.block);
    before = hash;
    const moves = afterMemorySection(original, found.start);
    if (hash === sha256(INBOX_NOTE_BLOCK)) {
      next = moves ? moveAboveMemory(original, found.start, found.end, found.block, nl) : original;
      action = moves ? "updated" : notes[agent] || !owner ? "unchanged" : "shared";
    } else if (owner ? ownedBy(owner.block_sha256, hash) : EARLIER_BLOCK_HASHES.has(hash)) {
      next = moves ? moveAboveMemory(original, found.start, found.end, blockIn(nl), nl) : original.slice(0, found.start) + blockIn(nl) + original.slice(found.end);
      action = "updated";
    } else {
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
  // The same file is another agent's note too: their records follow the block just brought up to date, or that agent would read Plannotator's own update as the person's edit.
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

export interface NoteRefresh {
  agent: InboxNoteAgentId;
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
  beforeWrite?: (path: string) => void;
}

/**
 * Brings every note Plannotator installed up to this version, with no action by the person; run at the Inbox's start.
 * Conservative: a block is replaced only when it is byte for byte an earlier version Plannotator wrote AND the one its record names; a block the person edited is never rewritten (the one exception is RETIRED_REPLY_PHRASE, swapped in place), a removed note is never put back, damaged markers write nothing, and a file changed since it was read is never clobbered. Never throws for one file.
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
    // Records first (throws, writing nothing, when they cannot be written), with a way back if the file's write then fails.
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
        // Best effort: if this also fails (or the process dies before the note's rename), the record names this version over the earlier block; ownedBy reads that as Plannotator's own, so the next start refreshes the note.
        writeInboxAgentNotes(dataDir, file);
      };
    };
    let result: NoteRefresh["result"];
    try {
      result = refreshNoteFile(path, recorded, options, commitRecords);
    } catch {
      result = "refused";
    }
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

/** The reply sentence of v1 to v6 and what replaces it inside a block the person edited. */
const RETIRED_REPLY_PHRASE = "otherwise call `wait_for_reply`";
const CURRENT_REPLY_PHRASE = "otherwise read the thread later with `read_thread`";

function refreshNoteFile(path: string, recorded: ReadonlySet<string>, options: RefreshInboxNotesOptions, commitRecords: () => () => void): NoteRefresh["result"] {
  const read = readAgentFile(path);
  if (read.kind === "missing") return "missing";
  if (read.kind === "refused") return "refused";
  const found = findBlock(read.text);
  if (found.kind === "none") return "none";
  if (found.kind === "damaged") return "damaged";
  const hash = sha256(found.block);
  const moves = afterMemorySection(read.text, found.start);
  const current = hash === sha256(INBOX_NOTE_BLOCK);
  if (current && (!moves || !recorded.has(hash))) return "current";
  const untouched = (current || EARLIER_BLOCK_HASHES.has(hash)) && [...recorded].some((r) => ownedBy(r, hash));
  // The one exception for an edited block: the exact retired sentence is swapped, every other byte and the record kept (so it still reads as edited).
  const patchedBlock = untouched ? null : found.block.split(RETIRED_REPLY_PHRASE).join(CURRENT_REPLY_PHRASE);
  const patching = patchedBlock !== null && patchedBlock !== found.block;
  if (!untouched && !patching) return "edited";
  const kept: NoteRefresh["result"] = untouched ? "read-only" : "edited";
  if ((read.mode & 0o200) === 0) return kept;
  if (statSync(read.target).nlink > 1) return untouched ? "hard-linked" : "edited";
  const nl = found.block.includes("\r\n") ? "\r\n" : "\n";
  const next = patching
    ? read.text.slice(0, found.start) + patchedBlock! + read.text.slice(found.end)
    : moves
      ? moveAboveMemory(read.text, found.start, found.end, blockIn(nl), nl)
      : read.text.slice(0, found.start) + blockIn(nl) + read.text.slice(found.end);
  options.beforeWrite?.(read.target);
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

export function removeInboxNote(agent: InboxNoteAgentId, dataDir: string, e: AgentEnvironment, path?: string): NoteChange {
  if (path) return removeNoteFrom(agent, dataDir, e, path);
  // Switching off removes the note from the file the record names AND from the file the agent reads now, when they differ (Codex's AGENTS.override.md).
  const record = readInboxAgentNotes(dataDir).notes[agent];
  const files: string[] = [];
  for (const file of [record?.path, noteTarget(agent, e).path, ...candidatePaths(agent, e)]) {
    if (file && !files.some((known) => resolved(known) === resolved(file))) files.push(file);
  }
  if (files.length === 0) return removeNoteFrom(agent, dataDir, e, undefined);
  const results = files.map((file) => removeNoteFrom(agent, dataDir, e, file));
  const failed = results.find((result) => !result.ok);
  if (failed) {
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
  skipped: string[];
}

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
          for (const other of owners) if (other !== agent) recordNote(dataDir, other, null);
          return removeInboxNote(agent, dataDir, e, path);
        },
      });
    }
  }
  return { items, skipped };
}

function noteAgentIds(value: unknown): InboxNoteAgentId[] | null {
  if (!Array.isArray(value)) return null;
  return INBOX_NOTE_AGENT_IDS.filter((id) => value.includes(id));
}

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

export function noteHolderIds(options: Pick<ConnectOptions, "dataDir" | "environment">): InboxNoteAgentId[] {
  const records = readInboxAgentNotes(options.dataDir).notes;
  return INBOX_NOTE_AGENT_IDS.filter((id) => {
    if (records[id]) return true;
    if (id === "cursor" || !agentSpec(id).detect(options.environment)) return false;
    const state = noteStatus(id, options.dataDir, options.environment).state;
    return state === "added" || state === "edited";
  });
}

/** The agents the note question has been asked about (config.json `inboxAgentNotes.asked`), always including every agent that has the note. A config of 0.28.18 or older recorded only `offered: true`; the first read converts it to the agents that can take a note now plus those that have it. */
export async function notesAsked(options: ConnectOptions): Promise<InboxNoteAgentId[]> {
  const saved = loadConfig().inboxAgentNotes;
  const recorded = noteAgentIds(saved?.asked);
  const holders = noteHolderIds(options);
  const base = recorded ?? (saved?.offered === true ? await noteCandidateIds(options) : []);
  const asked = INBOX_NOTE_AGENT_IDS.filter((id) => base.includes(id) || holders.includes(id));
  if (!recorded || asked.length !== recorded.length) {
    if (recorded || asked.length > 0) saveConfig({ inboxAgentNotes: { ...(loadConfig().inboxAgentNotes ?? {}), asked } });
  }
  return asked;
}

/** Record that these agents were asked. `offered` stays true for an older Inbox reading the same config. */
export async function markNotesAsked(ids: readonly InboxNoteAgentId[], options: ConnectOptions): Promise<void> {
  if (ids.length === 0) return;
  const before = await notesAsked(options);
  const asked = INBOX_NOTE_AGENT_IDS.filter((id) => before.includes(id) || ids.includes(id));
  saveConfig({ inboxAgentNotes: { ...(loadConfig().inboxAgentNotes ?? {}), offered: true, asked } });
}

/** Write the note for every connected agent proven to load it (INBOX_NOTE_AUTO_AGENT_IDS) that can take one now and was never asked about it. Each one written is recorded as asked, so a note the person removes never comes back by itself; one that cannot be written is left unasked and retried. Nothing with PLANNOTATOR_INBOX_NOTES=0, or in a test whose home is not a scratch folder. Returns the notes written (paths with `~`). */
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
    const saved = loadConfig().inboxAgentNotes ?? {};
    const unsaid = (saved.auto ?? []).filter((entry) => !added.some((next) => next.agent === entry.agent));
    saveConfig({ inboxAgentNotes: { ...saved, auto: [...unsaid, ...added] } });
  }
  return added;
}

export function unsaidAutoNotes(): InboxNoteAutoAdd[] {
  const auto = loadConfig().inboxAgentNotes?.auto;
  if (!Array.isArray(auto)) return [];
  return auto.filter(
    (entry): entry is InboxNoteAutoAdd =>
      !!entry && typeof entry.path === "string" && (INBOX_NOTE_AGENT_IDS as readonly string[]).includes(entry.agent),
  );
}

export function markAutoNotesSaid(shown?: readonly InboxNoteAutoAdd[]): void {
  const saved = loadConfig().inboxAgentNotes;
  if (!saved?.auto) return;
  const { auto, ...rest } = saved;
  const left = shown ? auto.filter((entry) => !shown.some((said) => said.agent === entry.agent && said.path === entry.path)) : [];
  saveConfig({ inboxAgentNotes: left.length > 0 ? { ...rest, auto: left } : rest });
}
