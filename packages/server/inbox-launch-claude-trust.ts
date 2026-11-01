/**
 * Claude Code's workspace trust, as the Inbox reads and accepts it: the run line's Trust folder button
 * (docs/agent-guides/inbox-launch.md, "Trusting a folder"). Claude-only; everything here was read from Claude Code
 * 2.1.316 and proved against a real `claude --bg` (.ops/research/claude-trust/).
 *
 * The key: `projects["<path>"].hasTrustDialogAccepted` in Claude's global config. The path is physical and NFC, of
 * the git root (a linked worktree's main checkout), else of the folder.
 *
 * The lock: Claude's vendored proper-lockfile. A folder made with `mkdir` at `<config path>.lock`, the config path
 * as named (a symlinked config locks beside the link), released with `rmdir`. A lock whose folder's mtime is 10 s
 * old is dead: a live holder touches it every 5 s. Claude re-reads the file once it holds the lock, so a key written
 * here under it survives Claude's next save.
 */

import { existsSync, mkdirSync, readFileSync, rmdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { describeFsError, placeKey, readAgentFile, withBom, writeAgentFileAtomic } from "./agent-files";
import { CLAUDE_JSON_MAX_BYTES } from "./inbox-agents";
import { setJsonMember } from "./json-edit";

/** A repository's main checkout for a linked worktree at `root`, as Claude resolves it; any other `root` stays. */
function claudeCheckoutRoot(root: string): string {
  try {
    const file = readFileSync(join(root, ".git"), "utf8").trim();
    if (!file.startsWith("gitdir:")) return root;
    const gitDir = resolve(root, file.slice("gitdir:".length).trim());
    const common = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
    if (dirname(gitDir) !== join(common, "worktrees")) return root;
    // The worktree must point back at this folder: a copied `.git` file does not.
    const back = resolve(gitDir, readFileSync(join(gitDir, "gitdir"), "utf8").trim());
    if (placeKey(back) !== join(placeKey(root), ".git")) return root;
    if (basename(common) === ".git") return dirname(common);
    // A bare repository is its own root; a repository's `.git` elsewhere names no checkout.
    return existsSync(join(common, ".git")) ? root : common;
  } catch {
    // A `.git` folder, or one that can't be read: this root.
    return root;
  }
}

/** The key Claude Code saves `folder`'s trust under: the git root (a worktree's main checkout), else the folder. */
export function claudeTrustKey(folder: string): string {
  const physical = placeKey(folder);
  for (let dir = physical; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return claudeCheckoutRoot(dir).normalize("NFC");
    if (dirname(dir) === dir) return physical.normalize("NFC");
  }
}

/** A lock this old is dead (proper-lockfile's `stale`, Claude's default). */
const CLAUDE_LOCK_STALE_MS = 10_000;
/** How long a click waits for the lock: long enough for a dead one to go stale. */
const CLAUDE_LOCK_WAIT_MS = 12_000;

function claudeLockIsStale(lock: string): boolean {
  try {
    return statSync(lock).mtimeMs < Date.now() - CLAUDE_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/** `work` while holding Claude's config lock. It is synchronous, milliseconds long, so the lock is never touched while held. */
async function withClaudeConfigLock(config: string, waitMs: number, work: () => void): Promise<void> {
  mkdirSync(dirname(config), { recursive: true });
  const lock = `${config}.lock`;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (claudeLockIsStale(lock)) {
      try {
        rmdirSync(lock);
        continue;
      } catch {
        // Another writer got there first, or it is not a lock: wait as for a live one.
      }
    }
    if (Date.now() >= deadline) throw new Error("Claude Code is holding it");
    await new Promise((done) => setTimeout(done, 40 + Math.random() * 80));
  }
  try {
    work();
  } finally {
    rmdirSync(lock);
  }
}

/**
 * Save `key` as trusted in the global config at `config`: that one value, every other byte as it was, in an atomic
 * write that keeps the file's mode. Throws with a short reason, the file untouched, when it can't be read as JSON.
 */
export async function acceptClaudeTrust(config: string, key: string, waitMs: number = CLAUDE_LOCK_WAIT_MS): Promise<void> {
  try {
    await withClaudeConfigLock(config, waitMs, () => {
      const read = readAgentFile(config, CLAUDE_JSON_MAX_BYTES);
      if (read.kind === "refused") throw new Error(read.reason);
      const file = read.kind === "file" ? read : null;
      const edit = setJsonMember(file?.text ?? "", ["projects", key], "hasTrustDialogAccepted", true);
      if (!edit.ok) throw new Error(edit.reason);
      if (edit.changed) writeAgentFileAtomic(read.target, withBom(edit.text, file?.bom === true), file?.mode ?? 0o600);
    });
  } catch (error) {
    throw new Error(describeFsError(error));
  }
}

/** The project files whose hooks and helpers run once a folder is trusted. */
const CLAUDE_SETTINGS_FILES = [".claude/settings.json", ".claude/settings.local.json"] as const;
const CLAUDE_MCP_FILE = ".mcp.json";
/** The settings that name a command Claude runs (the docs' "helper commands such as `apiKeyHelper`"). */
const CLAUDE_HELPER_SETTINGS = ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "gcpAuthRefresh", "otelHeadersHelper"] as const;

const recordOf = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const counted = (count: number, one: string): string | null => (count === 0 ? null : `${count} ${one}${count === 1 ? "" : "s"}`);

/** "a", "a and b", "a, b and c". */
function spoken(parts: readonly string[]): string {
  return parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The one line beside Trust folder: what these folders would turn on once trusted, by count, and any file that could
 * not be read. Null when there is nothing to say. Never shows what a file holds.
 */
export function claudeTrustWarning(folders: readonly string[]): string | null {
  const unread = new Set<string>();
  const read = (folder: string, name: string): Record<string, unknown> => {
    const file = readAgentFile(join(folder, name));
    if (file.kind === "missing") return {};
    try {
      if (file.kind === "file") return recordOf(JSON.parse(file.text));
    } catch {
      // Named below.
    }
    unread.add(name);
    return {};
  };
  let hooks = 0;
  let servers = 0;
  let helpers = 0;
  for (const folder of new Set(folders.map((f) => placeKey(f)))) {
    for (const name of CLAUDE_SETTINGS_FILES) {
      const settings = read(folder, name);
      for (const groups of Object.values(recordOf(settings.hooks))) {
        for (const group of listOf(groups)) hooks += listOf(recordOf(group).hooks).length;
      }
      helpers += CLAUDE_HELPER_SETTINGS.filter((key) => typeof settings[key] === "string").length;
    }
    for (const server of Object.values(recordOf(read(folder, CLAUDE_MCP_FILE).mcpServers))) {
      servers += 1;
      if (typeof recordOf(server).headersHelper === "string") helpers += 1;
    }
  }
  const found = [counted(hooks, "hook"), counted(servers, "MCP server"), counted(helpers, "helper command")].filter((part) => part !== null);
  const files = spoken([...unread]);
  if (found.length === 0) return files ? `This folder's ${files} couldn't be read, so it may run something once you trust it.` : null;
  const line = `This folder has ${spoken(found)} that will run once you trust it.`;
  return files ? `${line} Its ${files} couldn't be read, so there may be more.` : line;
}
