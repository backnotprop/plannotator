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

import {
  accessSync,
  constants as fsConstants,
  readdirSync,
  statSync,
  readFileSync,
} from "node:fs";
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
  /** Entry identity. Bookkeeping types (`last-prompt`, `ai-title`, `mode`) have none. */
  uuid?: string;
  /** The entry this one follows. `null` on the root entry. */
  parentUuid?: string | null;
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
 * Find a Claude session log by its exact session id across project slugs.
 * Returns null unless exactly one first-level project directory contains the
 * corresponding regular file.
 */
export function findClaudeSessionLogById(
  sessionId: string,
  projectsDirOverride?: string,
): string | null {
  if (
    typeof sessionId !== "string" ||
    !sessionId ||
    sessionId.includes("/") ||
    sessionId.includes("\\") ||
    sessionId.includes("\0") ||
    basename(sessionId) !== sessionId
  ) {
    return null;
  }

  const projectsDir = projectsDirOverride ?? DEFAULT_PROJECTS_DIR;
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }

  const matches: string[] = [];
  for (const projectDir of projectDirs) {
    const candidate = join(projectsDir, projectDir, `${sessionId}.jsonl`);
    try {
      if (statSync(candidate).isFile()) {
        accessSync(candidate, fsConstants.R_OK);
        matches.push(candidate);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
    }
    if (matches.length > 1) return null;
  }

  return matches[0] ?? null;
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

export type ClaudeSessionLogResolution =
  | { status: "unavailable" }
  | { status: "blocked"; source: "ancestor-pid" | "cwd-metadata" }
  | {
      status: "identified";
      sessionId: string;
      logPath: string | null;
      source: "ancestor-pid" | "cwd-metadata";
    };

export interface ClaudeSessionLogResolutionOptions {
  startPid?: number;
  cwd?: string;
  sessionsDir?: string;
  projectsDir?: string;
  getParentPid?: (pid: number) => number | null;
  maxHops?: number;
}

function parseSessionMetadata(value: unknown): SessionMetadata | null {
  if (!value || typeof value !== "object") return null;
  const meta = value as Record<string, unknown>;
  if (
    typeof meta.pid !== "number" ||
    !Number.isFinite(meta.pid) ||
    typeof meta.sessionId !== "string" ||
    !meta.sessionId ||
    typeof meta.cwd !== "string" ||
    !meta.cwd ||
    typeof meta.startedAt !== "number" ||
    !Number.isFinite(meta.startedAt)
  ) {
    return null;
  }
  return {
    pid: meta.pid,
    sessionId: meta.sessionId,
    cwd: meta.cwd,
    startedAt: meta.startedAt,
  };
}

type SessionMetadataReadResult =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "valid"; metadata: SessionMetadata };

function readSessionMetadataDetailed(
  pid: number,
  sessionsDir: string,
): SessionMetadataReadResult {
  const metaPath = join(sessionsDir, `${pid}.json`);
  let content: string;
  try {
    content = readFileSync(metaPath, "utf-8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { status: "absent" }
      : { status: "invalid" };
  }
  try {
    const metadata = parseSessionMetadata(JSON.parse(content));
    return metadata
      ? { status: "valid", metadata }
      : { status: "invalid" };
  } catch {
    return { status: "invalid" };
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
export function createDefaultGetParentPid(): (pid: number) => number | null {
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
type SessionRegistrationStatus = "registered" | "unregistered" | "unknown";

function resolveSessionRegistration(
  sessionId: string,
  sessionsDir: string,
): SessionRegistrationStatus {
  let files: string[];
  try {
    files = readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
  } catch {
    return "unknown";
  }

  for (const f of files) {
    let meta: SessionMetadata | null;
    try {
      meta = parseSessionMetadata(
        JSON.parse(readFileSync(join(sessionsDir, f), "utf-8")),
      );
    } catch {
      return "unknown";
    }
    if (!meta) return "unknown";
    if (meta.sessionId === sessionId) {
      return "registered";
    }
  }

  return "unregistered";
}

export function isSessionRegistered(
  sessionId: string,
  sessionsDir: string,
): boolean {
  return resolveSessionRegistration(sessionId, sessionsDir) === "registered";
}

/**
 * Resolve a session by walking up the PID chain, checking
 * `~/.claude/sessions/<pid>.json` at each hop for session metadata.
 *
 * The session id is resolved across project slugs because a worktree can move
 * after Claude records its launch cwd. When the exact log has a newer sibling,
 * an unregistered sibling is a "ghost" session created by /clear and wins.
 */
function resolveSessionLogByAncestorPidsDetailed(
  opts: ClaudeSessionLogResolutionOptions = {},
): ClaudeSessionLogResolution {
  const startPid = opts.startPid ?? process.ppid;
  if (!startPid) return { status: "unavailable" };
  const sessionsDir = opts.sessionsDir ?? DEFAULT_SESSIONS_DIR;
  // Fresh closure per call: each resolver invocation gets its own snapshot,
  // so the process table can't go stale between unrelated lookups.
  const getParent = opts.getParentPid ?? createDefaultGetParentPid();
  const maxHops = opts.maxHops ?? 8;

  const pids = getAncestorPids(startPid, maxHops, getParent);
  for (const pid of pids) {
    const metadata = readSessionMetadataDetailed(pid, sessionsDir);
    if (metadata.status === "absent") continue;
    if (metadata.status === "invalid") {
      return { status: "blocked", source: "ancestor-pid" };
    }
    const meta = metadata.metadata;

    const match = findClaudeSessionLogById(meta.sessionId, opts.projectsDir);
    if (!match) {
      return {
        status: "identified",
        sessionId: meta.sessionId,
        logPath: null,
        source: "ancestor-pid",
      };
    }
    const preciseMatch: ClaudeSessionLogResolution = {
      status: "identified",
      sessionId: meta.sessionId,
      logPath: match,
      source: "ancestor-pid",
    };

    // Check for stale metadata: if a newer sibling log has no registered
    // metadata, it's a ghost session from /clear — prefer it.
    const candidates = findSessionLogs(dirname(match));
    let matchMtime: number;
    try {
      matchMtime = statSync(match).mtimeMs;
    } catch {
      return preciseMatch;
    }
    for (const candidate of candidates) {
      if (candidate === match) break;
      try {
        if (statSync(candidate).mtimeMs <= matchMtime) break;
        const candidateSessionId = basename(candidate, ".jsonl");
        const registration = resolveSessionRegistration(
          candidateSessionId,
          sessionsDir,
        );
        if (registration === "unknown") {
          return preciseMatch;
        }
        if (registration === "unregistered") {
          return {
            status: "identified",
            sessionId: candidateSessionId,
            logPath: candidate,
            source: "ancestor-pid",
          };
        }
      } catch {
        return preciseMatch;
      }
    }

    return preciseMatch;
  }
  return { status: "unavailable" };
}

export function resolveSessionLogByAncestorPids(
  opts: ClaudeSessionLogResolutionOptions = {},
): string | null {
  const resolution = resolveSessionLogByAncestorPidsDetailed(opts);
  return resolution.status === "identified" ? resolution.logPath : null;
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
function resolveSessionLogByCwdScanDetailed(
  opts: ClaudeSessionLogResolutionOptions = {},
): ClaudeSessionLogResolution {
  const cwd = opts.cwd ?? process.cwd();
  const sessionsDir = opts.sessionsDir ?? DEFAULT_SESSIONS_DIR;

  let files: string[];
  try {
    files = readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
  } catch {
    return { status: "unavailable" };
  }

  const normalizedTarget = normalizeCwdForCompare(cwd);
  const candidates: SessionMetadata[] = [];
  for (const f of files) {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(join(sessionsDir, f), "utf-8"));
    } catch {
      // Cannot associate unreadable or malformed metadata with this cwd.
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const rawCwd = (value as Record<string, unknown>).cwd;
    if (
      typeof rawCwd !== "string" ||
      normalizeCwdForCompare(rawCwd) !== normalizedTarget
    ) {
      continue;
    }
    const meta = parseSessionMetadata(value);
    if (!meta) return { status: "blocked", source: "cwd-metadata" };
    candidates.push(meta);
  }

  // The newest matching metadata record is authoritative even if its log is
  // missing. Falling through could select a different concurrent session.
  candidates.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));

  const meta = candidates[0];
  if (!meta) return { status: "unavailable" };

  return {
    status: "identified",
    sessionId: meta.sessionId,
    logPath: findClaudeSessionLogById(meta.sessionId, opts.projectsDir),
    source: "cwd-metadata",
  };
}

export function resolveSessionLogByCwdScan(
  opts: ClaudeSessionLogResolutionOptions = {},
): string | null {
  const resolution = resolveSessionLogByCwdScanDetailed(opts);
  return resolution.status === "identified" ? resolution.logPath : null;
}

export function resolveClaudeSessionLog(
  opts: ClaudeSessionLogResolutionOptions = {},
): ClaudeSessionLogResolution {
  const ancestor = resolveSessionLogByAncestorPidsDetailed(opts);
  if (ancestor.status !== "unavailable") return ancestor;
  return resolveSessionLogByCwdScanDetailed(opts);
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
 * Resolve the entries that are actually part of the live conversation.
 *
 * Claude Code's transcript is append-only and tree-shaped: every entry records
 * the entry it follows in `parentUuid`. `/rewind` writes nothing at all — the
 * next message simply re-parents to an earlier entry, orphaning everything
 * that came after it. So file order and the live conversation diverge, and
 * reading the file bottom-up returns messages the user can no longer see.
 *
 * Walks `parentUuid` from the newest entry that has a `uuid` back to the root.
 * The newest entry is not necessarily the last line: bookkeeping types
 * (`last-prompt`, `ai-title`, `mode`, `file-history-snapshot`) carry no ids and
 * are frequently written last.
 *
 * Returns a set of indices into `entries`, so callers keep reporting real file
 * positions. Returns null when the chain can't be trusted — no ids at all, or a
 * walk that dead-ends instead of reaching the root — so callers can fall back
 * to a linear scan rather than returning nothing. Measured against 311 local
 * transcripts, every one reaches the root with no dangling parents or cycles.
 */
export function resolveActiveBranchIndices(
  entries: SessionLogEntry[],
): Set<number> | null {
  const indexByUuid = new Map<string, number>();
  let cursor = -1;
  for (let i = 0; i < entries.length; i++) {
    const uuid = entries[i]?.uuid;
    if (typeof uuid === "string" && uuid) {
      indexByUuid.set(uuid, i);
      cursor = i;
    }
  }
  if (cursor === -1) {
    return null;
  }

  const branch = new Set<number>();
  for (;;) {
    // A cycle would spin forever; treat a revisit as an untrustworthy chain.
    if (branch.has(cursor)) {
      return null;
    }
    branch.add(cursor);

    const parentUuid = entries[cursor]?.parentUuid;
    if (parentUuid === null || parentUuid === undefined) {
      return branch;
    }
    if (typeof parentUuid !== "string") {
      return null;
    }
    const parentIndex = indexByUuid.get(parentUuid);
    if (parentIndex === undefined) {
      return null;
    }
    cursor = parentIndex;
  }
}

/**
 * Extract up to `limit` of the most recent rendered assistant messages.
 *
 * Returned newest-first. Unlike `extractLastRenderedMessage`, this does not
 * stop at turn boundaries (human prompts) — picker UIs want a flat list of
 * recent assistant bubbles.
 *
 * Pass `branchIndices` (from `resolveActiveBranchIndices`) to skip entries that
 * a `/rewind` orphaned. Without it, entries are read in file order, which after
 * a rewind includes messages no longer in the conversation.
 *
 * Chunks of a single API message (same message.id) are concatenated.
 */
export function extractRecentRenderedMessages(
  entries: SessionLogEntry[],
  beforeIndex: number,
  limit: number,
  opts: { branchIndices?: Set<number> | null } = {},
): RenderedMessage[] {
  if (limit <= 0) return [];
  const { branchIndices } = opts;

  // Map preserves insertion order — we walk backward, so first key inserted is
  // newest. Each bucket collects the chunks of one API message (same message.id).
  const buckets = new Map<
    string,
    { chunks: { texts: string[]; lineNum: number }[]; timestamp?: string }
  >();

  for (let i = beforeIndex - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) continue;
    if (branchIndices && !branchIndices.has(i)) continue;

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
 *
 * `activeBranchOnly` restricts the read to the live conversation branch, so a
 * `/rewind` doesn't surface orphaned messages. Only meaningful for transcripts
 * that carry `uuid`/`parentUuid` (Claude Code); an untrustworthy or absent
 * chain silently degrades to a plain file-order read.
 *
 * A `/compact` boundary is also a tree root (`parentUuid: null`), so right
 * after a compaction the active branch may contain no assistant messages at
 * all. An empty filtered result falls back to the file-order read: callers
 * treat "no messages" as "wrong log file" and would walk off to an older
 * session, which is strictly worse than offering the pre-compaction messages
 * the user just watched scroll by.
 */
export function getRecentRenderedMessages(
  logPath: string,
  limit: number,
  opts: { activeBranchOnly?: boolean } = {},
): RenderedMessage[] {
  try {
    const content = readFileSync(logPath, "utf-8");
    const entries = parseSessionLog(content);
    const branchIndices = opts.activeBranchOnly
      ? resolveActiveBranchIndices(entries)
      : null;
    const messages = extractRecentRenderedMessages(entries, entries.length, limit, {
      branchIndices,
    });
    if (messages.length === 0 && branchIndices) {
      // Fail open, never fail empty: an empty active branch (fresh /compact)
      // must not make this log look like the wrong file.
      return extractRecentRenderedMessages(entries, entries.length, limit);
    }
    return messages;
  } catch {
    return [];
  }
}
