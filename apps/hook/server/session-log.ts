/**
 * Session Log Parser
 *
 * Extracts the last rendered assistant message from local agent session logs.
 * Used by the "annotate-last" feature to let users annotate the most recent
 * assistant response in the annotation UI.
 *
 * Currently supports:
 *   - Claude Code: ~/.claude/projects/{project-slug}/{session-id}.jsonl
 *   - Droid/Factory: ~/.factory/sessions/{project-slug}/{session-id}.jsonl
 *
 * Each line is a JSON object with a `type` field. Assistant messages may be
 * split across multiple lines sharing the same logical message id. Text
 * content blocks (`type: "text"` inside `message.content`) are what the user
 * sees rendered in chat.
 */

import { readdirSync, statSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";

const claudeConfigDir =
  process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const DEFAULT_SESSIONS_DIR = join(claudeConfigDir, "sessions");
const DEFAULT_PROJECTS_DIR = join(claudeConfigDir, "projects");
const factoryConfigDir =
  process.env.FACTORY_CONFIG_DIR || join(homedir(), ".factory");
const DEFAULT_FACTORY_SESSIONS_DIR = join(factoryConfigDir, "sessions");

/**
 * Normalize a cwd for comparison. On Windows, filesystems are case-insensitive
 * and processes can report drive letters in either case, so we lowercase and
 * fold slashes. On Unix, cwds are compared as-is.
 */
export function normalizeCwdForCompare(cwd: string): string {
  if (process.platform === "win32") {
    return cwd.replace(/\//g, "\\").toLowerCase();
  }
  return cwd;
}

// --- Types ---

export interface SessionLogEntry {
  type: string;
  id?: string;
  visibility?: string;
  message?: {
    id?: string;
    role?: string;
    visibility?: string;
    content?: string | ContentBlock[];
  };
  [key: string]: unknown;
}

interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface RenderedMessage {
  /** The API message ID (shared across streamed chunks) */
  messageId: string;
  /** Concatenated text from all text blocks */
  text: string;
  /** Line numbers in the JSONL where this message appeared */
  lineNumbers: number[];
  /** Timestamp from the entry (ISO 8601), if available */
  timestamp?: string;
}

// --- Session File Discovery ---

/**
 * Derive the project slug from a working directory path.
 * Claude Code replaces every character outside [a-zA-Z0-9-] with `-`.
 * On Windows it also lowercases drive letters (C: → c-).
 */
export function projectSlugFromCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9-]/g, "-");
}

/**
 * Find all .jsonl session log files in a project directory,
 * sorted by modification time (most recent first).
 * Returns empty array if no session logs exist.
 */
export function findSessionLogs(projectDir: string): string[] {
  let files: string[];
  try {
    files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }

  if (files.length === 0) return [];

  const withMtime: { path: string; mtime: number }[] = [];
  for (const f of files) {
    const full = join(projectDir, f);
    try {
      withMtime.push({ path: full, mtime: statSync(full).mtimeMs });
    } catch {
      // File disappeared between readdir and stat — skip
    }
  }

  return withMtime
    .sort((a, b) => b.mtime - a.mtime)
    .map((f) => f.path);
}

/**
 * Find session log candidates for a given working directory.
 * Returns all .jsonl paths sorted by mtime (most recent first).
 *
 * Tries the exact slug first, then a case-insensitive match. On Windows,
 * Claude Code lowercases the entire slug (e.g. `C-Users-...` → `c-users-...`)
 * while our cwd may have mixed case. The fallback scans the projects directory
 * for a case-insensitive match.
 */
export function findSessionLogsForCwd(cwd: string, projectsDirOverride?: string): string[] {
  const slug = projectSlugFromCwd(cwd);
  const projectsDir = projectsDirOverride ?? DEFAULT_PROJECTS_DIR;
  const projectDir = join(projectsDir, slug);

  // Try exact match first
  const logs = findSessionLogs(projectDir);
  if (logs.length > 0) return logs;

  // Fallback: case-insensitive directory scan (handles Windows drive letter casing)
  const slugLower = slug.toLowerCase();
  try {
    const dirs = readdirSync(projectsDir);
    for (const dir of dirs) {
      if (dir.toLowerCase() === slugLower) {
        const fallbackLogs = findSessionLogs(join(projectsDir, dir));
        if (fallbackLogs.length > 0) return fallbackLogs;
      }
    }
  } catch {
    // projectsDir doesn't exist
  }

  return [];
}

/**
 * Find Droid/Factory session log candidates for a given working directory.
 * Returns all .jsonl paths sorted by mtime (most recent first).
 */
export function findDroidSessionLogsForCwd(
  cwd: string,
  sessionsDirOverride?: string,
): string[] {
  return findSessionLogsForCwd(cwd, sessionsDirOverride ?? DEFAULT_FACTORY_SESSIONS_DIR);
}

/**
 * Walk up the directory tree trying each ancestor against the Droid/Factory
 * sessions directory. Useful when the user `cd`'d into a subdirectory after
 * the session started.
 */
export function findDroidSessionLogsByAncestorWalk(
  cwd: string,
  sessionsDirOverride?: string,
): string[] {
  return findSessionLogsByAncestorWalk(
    cwd,
    sessionsDirOverride ?? DEFAULT_FACTORY_SESSIONS_DIR,
  );
}

/**
 * Best-effort current Droid/Factory session log resolution for a cwd.
 *
 * Factory does not expose per-process session metadata, so the safest
 * available selector is the newest exact-cwd log, falling back to the newest
 * log from the first ancestor slug with any sessions. Callers should inspect
 * only this selected log and fail cleanly if it contains no assistant reply,
 * rather than falling through to older sibling sessions.
 */
export function resolveDroidSessionLogForCwd(
  cwd: string,
  sessionsDirOverride?: string,
): string | null {
  const sessionsDir = sessionsDirOverride ?? DEFAULT_FACTORY_SESSIONS_DIR;
  const exactLogs = findDroidSessionLogsForCwd(cwd, sessionsDir);
  if (exactLogs.length > 0) return exactLogs[0];

  const ancestorLogs = findDroidSessionLogsByAncestorWalk(cwd, sessionsDir);
  return ancestorLogs[0] ?? null;
}

// --- Session Metadata Resolution ---

/**
 * Claude Code writes per-process session metadata to:
 *   ~/.claude/sessions/<pid>.json
 *
 * Each file contains:
 *   { pid, sessionId, cwd, startedAt }
 *
 * This lets us deterministically resolve the correct session log
 * when the shell CWD has diverged from the session's project directory
 * (e.g. after the user runs `cd` during a session).
 */

export interface SessionMetadata {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
}

/**
 * Read a Claude Code session metadata file for a given PID.
 * Returns null if the file doesn't exist or can't be parsed.
 */
function readSessionMetadata(
  pid: number,
  sessionsDir: string
): SessionMetadata | null {
  const metaPath = join(sessionsDir, `${pid}.json`);
  try {
    return JSON.parse(readFileSync(metaPath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Parse `ps -eo pid=,ppid=` output into a pid → ppid map.
 * Each non-empty line is expected to be two whitespace-separated integers.
 * Malformed lines are skipped.
 */
export function parseProcessTablePs(stdout: string): Map<number, number> {
  const table = new Map<number, number>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const pid = parseInt(parts[0], 10);
    const ppid = parseInt(parts[1], 10);
    if (Number.isFinite(pid) && Number.isFinite(ppid)) {
      table.set(pid, ppid);
    }
  }
  return table;
}

/**
 * Parse PowerShell `Get-CimInstance Win32_Process | ConvertTo-Csv` output
 * into a pid → ppid map. Skips the CSV header and any malformed rows.
 */
export function parseProcessTableCsv(stdout: string): Map<number, number> {
  const table = new Map<number, number>();
  const lines = stdout.split(/\r?\n/);
  // Skip the CSV header row if present
  for (let i = 1; i < lines.length; i++) {
    const match = lines[i].trim().match(/^"?(\d+)"?\s*,\s*"?(\d+)"?$/);
    if (!match) continue;
    const pid = parseInt(match[1], 10);
    const ppid = parseInt(match[2], 10);
    if (Number.isFinite(pid) && Number.isFinite(ppid)) {
      table.set(pid, ppid);
    }
  }
  return table;
}

/**
 * Snapshot the entire process table in a single spawn, platform-aware.
 *
 * Unix: `ps -eo pid=,ppid=` (suppresses headers with trailing `=`).
 * Windows: `powershell Get-CimInstance Win32_Process | ConvertTo-Csv`.
 *   PowerShell 5.1 ships with every Windows install as `powershell.exe`.
 *
 * Returns an empty map on any failure (missing binary, non-zero exit, timeout).
 * Callers walk the returned map with cycle detection, so an empty map just
 * means the ancestor-PID resolver degrades to tier 2.
 */
function snapshotProcessTable(): Map<number, number> {
  try {
    if (process.platform === "win32") {
      const result = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Csv -NoTypeInformation",
        ],
        { encoding: "utf-8", timeout: 2000 }
      );
      if (result.status !== 0) return new Map();
      return parseProcessTableCsv(result.stdout);
    }
    const result = spawnSync("ps", ["-eo", "pid=,ppid="], {
      encoding: "utf-8",
      timeout: 2000,
    });
    if (result.status !== 0) return new Map();
    return parseProcessTablePs(result.stdout);
  } catch {
    return new Map();
  }
}

/**
 * Default `getParentPid` implementation. Snapshots the process table lazily
 * on first call and caches it for the lifetime of the closure, so walking
 * up to `maxHops` ancestors costs a single spawn instead of one per hop.
 */
function createDefaultGetParentPid(): (pid: number) => number | null {
  let table: Map<number, number> | null = null;
  return (pid: number) => {
    if (table === null) table = snapshotProcessTable();
    const ppid = table.get(pid);
    return ppid && ppid > 0 ? ppid : null;
  };
}

/**
 * Walk up the process tree from `startPid`, collecting PIDs until we hit
 * init (PID 1), a cycle, or `maxHops` is reached.
 *
 * Why: when plannotator is spawned by a slash command's `!` bang, the direct
 * parent is a bash subshell — not Claude Code. Claude's `sessions/<pid>.json`
 * lives a few hops up. We can't assume `process.ppid` is the right PID.
 */
export function getAncestorPids(
  startPid: number,
  maxHops: number,
  getParent: (pid: number) => number | null
): number[] {
  if (!startPid || startPid <= 1) return [];
  const chain: number[] = [];
  const seen = new Set<number>();
  let pid: number | null = startPid;
  while (chain.length < maxHops && pid !== null && pid > 1 && !seen.has(pid)) {
    chain.push(pid);
    seen.add(pid);
    pid = getParent(pid);
  }
  return chain;
}

/**
 * Check if a sessionId is referenced by any metadata file in the sessions dir.
 * Used to distinguish "ghost" sessions (created by /clear but never registered
 * in metadata) from legitimate concurrent sessions (which have their own PID's
 * metadata file).
 */
export function isSessionRegistered(
  sessionId: string,
  sessionsDir: string
): boolean {
  try {
    const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      try {
        const meta: SessionMetadata = JSON.parse(
          readFileSync(join(sessionsDir, f), "utf-8")
        );
        if (meta?.sessionId === sessionId) return true;
      } catch {
        // Malformed file — skip
      }
    }
  } catch {
    // sessionsDir unreadable
  }
  return false;
}

/**
 * Resolve a session log path by walking up the PID chain, checking
 * `~/.claude/sessions/<pid>.json` at each hop for a session metadata match.
 *
 * When the matched log is not the most recently modified file in the project
 * directory, checks whether the newer file is a "ghost" session — one created
 * by /clear that was never registered in any metadata file. If so, prefers the
 * ghost (it's the current session). If the newer file belongs to a registered
 * concurrent session, keeps the PID-based result.
 */
export function resolveSessionLogByAncestorPids(
  opts: {
    startPid?: number;
    sessionsDir?: string;
    projectsDir?: string;
    getParentPid?: (pid: number) => number | null;
    maxHops?: number;
  } = {}
): string | null {
  const startPid = opts.startPid ?? process.ppid;
  if (!startPid) return null;
  const sessionsDir = opts.sessionsDir ?? DEFAULT_SESSIONS_DIR;
  // Fresh closure per call: each resolver invocation gets its own snapshot,
  // so the process table can't go stale between unrelated lookups.
  const getParent = opts.getParentPid ?? createDefaultGetParentPid();
  const maxHops = opts.maxHops ?? 8;

  const pids = getAncestorPids(startPid, maxHops, getParent);
  for (const pid of pids) {
    const meta = readSessionMetadata(pid, sessionsDir);
    if (!meta?.sessionId || !meta?.cwd) continue;

    const candidates = findSessionLogsForCwd(meta.cwd, opts.projectsDir);
    const match = candidates.find((p) => p.includes(meta.sessionId));
    if (match) {
      // Check for stale metadata: if a newer log exists that has no
      // registered metadata, it's a ghost session from /clear — prefer it.
      if (candidates[0] !== match) {
        const newestSessionId = basename(candidates[0], ".jsonl");
        if (!isSessionRegistered(newestSessionId, sessionsDir)) {
          return candidates[0];
        }
      }
      return match;
    }
  }
  return null;
}

/**
 * Resolve a session log path by scanning all `~/.claude/sessions/*.json`
 * metadata files, filtering to those whose `cwd` matches, and picking the
 * session with the most recent `startedAt`.
 *
 * Better than "newest jsonl mtime in the project dir" because it uses
 * session-level metadata rather than file modification time, which can be
 * touched by unrelated processes or resumed sessions.
 */
export function resolveSessionLogByCwdScan(
  opts: {
    cwd?: string;
    sessionsDir?: string;
    projectsDir?: string;
  } = {}
): string | null {
  const cwd = opts.cwd ?? process.cwd();
  const sessionsDir = opts.sessionsDir ?? DEFAULT_SESSIONS_DIR;

  let files: string[];
  try {
    files = readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }

  const normalizedTarget = normalizeCwdForCompare(cwd);
  const candidates: SessionMetadata[] = [];
  for (const f of files) {
    try {
      const meta: SessionMetadata = JSON.parse(
        readFileSync(join(sessionsDir, f), "utf-8")
      );
      if (
        meta?.sessionId &&
        meta?.cwd &&
        normalizeCwdForCompare(meta.cwd) === normalizedTarget
      ) {
        candidates.push(meta);
      }
    } catch {
      // Malformed metadata file — skip
    }
  }

  // Newest sessions first — pick the most recently started session that has a matching jsonl
  candidates.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));

  const logs = findSessionLogsForCwd(cwd, opts.projectsDir);
  for (const meta of candidates) {
    const match = logs.find((p) => p.includes(meta.sessionId));
    if (match) return match;
  }
  return null;
}

/**
 * Walk up the directory tree from `cwd` trying each ancestor as a project slug.
 * Returns session logs from the first ancestor that has any, sorted by mtime.
 *
 * Used as a fallback when session metadata resolution (PPID) is unavailable.
 * Stops at the filesystem root to avoid infinite loops.
 */
export function findSessionLogsByAncestorWalk(
  cwd: string,
  projectsDirOverride?: string
): string[] {
  let dir = dirname(cwd);
  if (dir === cwd) return [];

  while (true) {
    const logs = findSessionLogsForCwd(dir, projectsDirOverride);
    if (logs.length > 0) return logs;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return [];
}

// --- Log Parsing ---

/**
 * Parse a JSONL session log into entries.
 * Invalid lines are silently skipped.
 */
export function parseSessionLog(content: string): SessionLogEntry[] {
  const lines = content.trim().split("\n");
  const entries: SessionLogEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

/**
 * Prefixes that indicate system-generated user messages, not real human input.
 * Claude Code logs local command caveats, command names, stdout/stderr, and
 * other system messages as type:"user" with string content.
 */
const SYSTEM_USER_PREFIXES = [
  "<local-command-",
  "<command-name>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<system-reminder>",
  "<system-notification>",
];

function getEntryRole(entry: SessionLogEntry): "user" | "assistant" | null {
  if (entry.type === "user" || entry.type === "assistant") return entry.type;
  const role = entry.message?.role;
  return role === "user" || role === "assistant" ? role : null;
}

function getVisibleTextBlocks(content: string | ContentBlock[] | undefined): string[] {
  if (typeof content === "string") {
    return content.trim() ? [content] : [];
  }
  if (!Array.isArray(content)) return [];
  return content
    .filter((b: ContentBlock) => b.type === "text" && b.text?.trim())
    .map((b: ContentBlock) => b.text!);
}

function getEntryVisibility(entry: SessionLogEntry): string | undefined {
  return entry.visibility ?? entry.message?.visibility;
}

function isHiddenTranscriptEntry(entry: SessionLogEntry): boolean {
  const visibility = getEntryVisibility(entry)?.trim().toLowerCase();
  return visibility === "llm_only" || visibility === "assistant_only" || visibility === "hidden";
}

function getEntryMessageId(entry: SessionLogEntry): string | undefined {
  return entry.message?.id ?? entry.id;
}

/**
 * Check if a session log entry is a human-typed user prompt
 * (as opposed to a tool result or system-generated user message).
 */
export function isHumanPrompt(entry: SessionLogEntry): boolean {
  if (getEntryRole(entry) !== "user") return false;
  if (isHiddenTranscriptEntry(entry)) return false;
  const blocks = getVisibleTextBlocks(entry.message?.content);
  if (blocks.length === 0) return false;
  const content = blocks.join("\n");
  // Filter out system-generated user messages
  for (const prefix of SYSTEM_USER_PREFIXES) {
    if (content.startsWith(prefix)) return false;
  }
  return true;
}

/**
 * Check if a session log entry is an assistant message with rendered text.
 */
function hasTextContent(entry: SessionLogEntry): boolean {
  if (getEntryRole(entry) !== "assistant") return false;
  if (isHiddenTranscriptEntry(entry)) return false;
  return getVisibleTextBlocks(entry.message?.content).length > 0;
}

/**
 * Extract text blocks from an assistant message's content array.
 */
function extractTextBlocks(entry: SessionLogEntry): string[] {
  if (getEntryRole(entry) !== "assistant") return [];
  if (isHiddenTranscriptEntry(entry)) return [];
  return getVisibleTextBlocks(entry.message?.content);
}

/**
 * Find the anchor index: the last human prompt at or before `beforeIndex`
 * whose content includes `anchorText`.
 * If no anchorText is provided, returns the index of the last human prompt.
 */
export function findAnchorIndex(
  entries: SessionLogEntry[],
  anchorText?: string,
  beforeIndex?: number
): number {
  const end = beforeIndex ?? entries.length - 1;
  for (let i = end; i >= 0; i--) {
    if (!isHumanPrompt(entries[i])) continue;
    if (!anchorText) return i;
    const content = getVisibleTextBlocks(entries[i].message?.content).join("\n");
    if (content.includes(anchorText)) return i;
  }
  return -1;
}

/**
 * Extract the last rendered assistant message before a given index.
 *
 * Finds the last message.id with text content — the final "bubble" the user
 * sees in the TUI. Collects all text chunks for that message.id only.
 *
 * Skips noise entries and non-human user messages. If no text is found
 * in the current turn, walks backward through earlier turns.
 */
export function extractLastRenderedMessage(
  entries: SessionLogEntry[],
  beforeIndex: number
): RenderedMessage | null {
  let targetMessageId: string | null = null;
  const textParts: { text: string; lineNum: number }[] = [];

  for (let i = beforeIndex - 1; i >= 0; i--) {
    const entry = entries[i];

    // Skip noise
    if (entry.type === "progress" || entry.type === "system") continue;
    if (entry.type === "file-history-snapshot") continue;
    if (entry.type === "queue-operation") continue;

    // Skip non-human user messages (tool results, system-generated)
    if (getEntryRole(entry) === "user" && !isHumanPrompt(entry)) continue;

    // At a human prompt: if we already have text, stop.
    // If no text yet, skip and keep looking in earlier turns.
    if (isHumanPrompt(entry)) {
      if (textParts.length > 0) break;
      continue;
    }

    if (getEntryRole(entry) !== "assistant") continue;

    // If we already locked onto a message.id, collect earlier chunks of it
    if (targetMessageId) {
      const msgId = getEntryMessageId(entry);
      if (msgId !== targetMessageId) break;
      const texts = extractTextBlocks(entry);
      if (texts.length > 0) {
        textParts.push(...texts.map((t) => ({ text: t, lineNum: i + 1 })));
      }
      continue;
    }

    // Haven't found target yet — look for assistant with text
    if (!hasTextContent(entry)) continue;
    const msgId = getEntryMessageId(entry);
    if (!msgId) continue;

    targetMessageId = msgId;
    const texts = extractTextBlocks(entry);
    textParts.push(...texts.map((t) => ({ text: t, lineNum: i + 1 })));
  }

  if (!targetMessageId || textParts.length === 0) return null;

  textParts.reverse();

  return {
    messageId: targetMessageId,
    text: textParts.map((p) => p.text).join("\n"),
    lineNumbers: textParts.map((p) => p.lineNum),
  };
}

/**
 * High-level: extract the last rendered assistant message from a session log file.
 *
 * Starts from the END of the log (no anchoring). The slash command's
 * <command-message> entry isn't written until after the binary completes,
 * so we can't anchor on it. Instead, we just find the last assistant
 * text entry in the entire log.
 */
export function getLastRenderedMessage(
  logPath: string,
): RenderedMessage | null {
  try {
    const content = readFileSync(logPath, "utf-8");
    const entries = parseSessionLog(content);
    return extractLastRenderedMessage(entries, entries.length);
  } catch {
    return null;
  }
}

/**
 * Extract up to `limit` of the most recent rendered assistant messages.
 *
 * Returned newest-first. Unlike `extractLastRenderedMessage`, this does not
 * stop at turn boundaries (human prompts) — picker UIs want a flat list of
 * recent assistant bubbles. Necessary for the rewind case: after `/rewind`,
 * the message at the bottom of the terminal isn't the newest transcript
 * entry, so the user needs to pick from a list.
 *
 * Chunks of a single API message (same message.id) are concatenated.
 */
export function extractRecentRenderedMessages(
  entries: SessionLogEntry[],
  beforeIndex: number,
  limit: number,
): RenderedMessage[] {
  if (limit <= 0) return [];

  // Map preserves insertion order — we walk backward, so first key inserted is
  // newest. Each bucket collects the chunks of one API message (same message.id).
  const buckets = new Map<
    string,
    { chunks: { texts: string[]; lineNum: number }[]; timestamp?: string }
  >();

  for (let i = beforeIndex - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) continue;

    if (entry.type === "progress" || entry.type === "system") continue;
    if (entry.type === "file-history-snapshot") continue;
    if (entry.type === "queue-operation") continue;
    if (getEntryRole(entry) !== "assistant") continue;
    if (isHiddenTranscriptEntry(entry)) continue;

    const texts = extractTextBlocks(entry);
    if (texts.length === 0) continue;
    const msgId = getEntryMessageId(entry);
    if (!msgId) continue;

    let bucket = buckets.get(msgId);
    if (!bucket) {
      if (buckets.size >= limit) continue;
      const ts = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
      bucket = { chunks: [], timestamp: ts };
      buckets.set(msgId, bucket);
    }
    bucket.chunks.push({ texts, lineNum: i + 1 });
  }

  return Array.from(buckets, ([messageId, b]) => {
    // Walked backward, so reverse to restore chronological order within a message
    const chrono = b.chunks.slice().reverse();
    return {
      messageId,
      text: chrono.flatMap((e) => e.texts).join("\n"),
      lineNumbers: chrono.map((e) => e.lineNum),
      timestamp: b.timestamp,
    };
  });
}

/**
 * High-level: read up to `limit` recent assistant messages from a session log.
 */
export function getRecentRenderedMessages(
  logPath: string,
  limit: number,
): RenderedMessage[] {
  try {
    const content = readFileSync(logPath, "utf-8");
    const entries = parseSessionLog(content);
    return extractRecentRenderedMessages(entries, entries.length, limit);
  } catch {
    return [];
  }
}
