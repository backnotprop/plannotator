/**
 * Claude Code's workspace trust, as the Inbox reads and accepts it: the run line's Trust folder button
 * (docs/agent-guides/inbox-launch.md, "Trusting a folder"). Claude-only. The key, the lock and what the warning covers
 * were read from the Claude Code 2.1.316 binary; the key was proved against a real `claude --bg`, in a plain repository
 * (.ops/research/claude-trust/). A linked worktree and a race with Claude's own write were not run.
 *
 * The key: `projects["<path>"].hasTrustDialogAccepted` in Claude's global config. The path is physical and NFC, of
 * the git root (a linked worktree's main checkout), else of the folder.
 *
 * The lock: Claude's vendored proper-lockfile. A folder made with `mkdir` at `<config path>.lock`, the config path
 * as named (a symlinked config locks beside the link), released with `rmdir`. A lock whose folder's mtime is 10 s
 * old is dead: a live holder touches it every 5 s. Claude re-reads the file once it holds the lock, so a key written
 * here under it survives Claude's next save.
 */

import { existsSync, mkdirSync, rmdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { describeFsError, placeKey, readAgentFile, withBom, writeAgentFileAtomic } from "./agent-files";
import { CLAUDE_JSON_MAX_BYTES } from "./inbox-agents";
import type { LaunchTrustReading } from "./inbox-launch-host";
import { setJsonMember } from "./json-edit";

/** A file's words, or a throw: `readAgentFile` opens regular files only, and a FIFO would block the Inbox here. */
function regularText(path: string): string {
  const read = readAgentFile(path);
  if (read.kind !== "file") throw new Error(`${path} can't be read`);
  return read.text.trim();
}

/** A `.git` git would take: a file or a folder, never a FIFO or a socket of that name. */
function hasGit(dir: string): boolean {
  try {
    const stat = statSync(join(dir, ".git"));
    return stat.isFile() || stat.isDirectory();
  } catch {
    return false;
  }
}

/** A repository's main checkout for a linked worktree at `root`, as Claude resolves it; any other `root` stays. */
function claudeCheckoutRoot(root: string): string {
  try {
    const file = regularText(join(root, ".git"));
    if (!file.startsWith("gitdir:")) return root;
    const gitDir = resolve(root, file.slice("gitdir:".length).trim());
    const common = resolve(gitDir, regularText(join(gitDir, "commondir")));
    if (dirname(gitDir) !== join(common, "worktrees")) return root;
    // The worktree must point back at this folder: a copied `.git` file does not.
    const back = resolve(gitDir, regularText(join(gitDir, "gitdir")));
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
    if (hasGit(dir)) return claudeCheckoutRoot(dir).normalize("NFC");
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
  let stuck = false;
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
      } catch (error) {
        // Gone: another writer got there first. Anything else is a file or a full folder, not a lock.
        stuck = (error as NodeJS.ErrnoException).code !== "ENOENT";
      }
    }
    if (Date.now() >= deadline) throw new Error(stuck ? `${basename(lock)} is in the way and can't be removed` : "Claude Code is holding it");
    await new Promise((done) => setTimeout(done, 40 + Math.random() * 80));
  }
  try {
    work();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      // Never hides what `work` did: a lock left here is cleared as dead in 10 s.
    }
  }
}

/**
 * Save `key` as trusted in the global config at `config`: that one value, every other byte as it was, in an atomic
 * write that keeps the file's mode, flushed to disk before the rename as Claude's own save is. Throws with a short
 * reason, the file untouched, when it can't be read as JSON. An empty file counts: Claude treats one as corrupted and
 * repairs it from its cache, which a file holding only this key would stop. `allowed`: asked once the lock is held,
 * after a wait that can run to `waitMs`; no saves nothing.
 */
export async function acceptClaudeTrust(config: string, key: string, waitMs: number = CLAUDE_LOCK_WAIT_MS, allowed: () => boolean = () => true): Promise<void> {
  try {
    await withClaudeConfigLock(config, waitMs, () => {
      if (!allowed()) return;
      const read = readAgentFile(config, CLAUDE_JSON_MAX_BYTES);
      if (read.kind === "refused") throw new Error(read.reason);
      const file = read.kind === "file" ? read : null;
      if (file && !file.text.trim()) throw new Error("it is empty");
      const edit = setJsonMember(file?.text ?? "", ["projects", key], "hasTrustDialogAccepted", true);
      if (!edit.ok) throw new Error(edit.reason);
      if (edit.changed) writeAgentFileAtomic(read.target, withBom(edit.text, file?.bom === true), file?.mode ?? 0o600, true, true);
    });
  } catch (error) {
    throw new Error(describeFsError(error));
  }
}

/** The project files whose hooks and helpers run once a folder is trusted. */
const CLAUDE_SETTINGS_FILES = [".claude/settings.json", ".claude/settings.local.json"] as const;
const CLAUDE_MCP_FILE = ".mcp.json";
/** The settings that name a command Claude runs for its credentials or headers, as its own trust prompt lists them. */
const CLAUDE_HELPER_SETTINGS = ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport", "gcpAuthRefresh", "otelHeadersHelper", "proxyAuthHelper"] as const;
/** The settings that hold a command of their own, run like a hook. */
const CLAUDE_COMMAND_SETTINGS = ["statusLine", "subagentStatusLine", "fileSuggestion"] as const;

const recordOf = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const counted = (count: number, one: string): string | null => (count === 0 ? null : `${count} ${one}${count === 1 ? "" : "s"}`);

/** "a", "a and b", "a, b and c". */
function spoken(parts: readonly string[]): string {
  return parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * What `folders` would turn on once trusted, as Claude's own trust prompt counts it (2.1.316), and any file that could
 * not be read, said two ways from one read: the run line's one `warning` beside Trust folder (null when there is
 * nothing to say) and compose's short `facts`. `.mcp.json` counts from each folder up to the file system's root, as
 * Claude reads it, by server name; a server in `disabledMcpjsonServers` never starts and does not count. `repository`:
 * where the trust lands when that is not the folder shown (`shown`), and that folder's own name (`folder`). `warns`:
 * anything but that (the question circle's warning colour). Never shows what a file holds.
 */
export function claudeTrustReading(folders: readonly string[], repository: { shown: string; folder: string } | null = null): LaunchTrustReading {
  /** Each file that could not be read, by path, with its name. */
  const unread = new Map<string, string>();
  const read = (folder: string, name: string): Record<string, unknown> => {
    const file = readAgentFile(join(folder, name));
    if (file.kind === "missing") return {};
    try {
      if (file.kind === "file") return recordOf(JSON.parse(file.text));
    } catch {
      // Named below.
    }
    unread.set(join(folder, name), name);
    return {};
  };
  const places = new Set(folders.map((f) => placeKey(f)));
  const disabled = new Set<unknown>();
  let hooks = 0;
  let helpers = 0;
  let env = false;
  let tools = false;
  let outside = false;
  for (const folder of places) {
    for (const name of CLAUDE_SETTINGS_FILES) {
      const settings = read(folder, name);
      for (const groups of Object.values(recordOf(settings.hooks))) {
        for (const group of listOf(groups)) hooks += listOf(recordOf(group).hooks).length;
      }
      hooks += CLAUDE_COMMAND_SETTINGS.filter((key) => typeof recordOf(settings[key]).command === "string").length;
      helpers += CLAUDE_HELPER_SETTINGS.filter((key) => typeof settings[key] === "string").length;
      helpers += Object.values(recordOf(settings.extraKnownMarketplaces)).filter((m) => typeof recordOf(recordOf(m).source).headersHelper === "string").length;
      env ||= Object.keys(recordOf(settings.env)).length > 0;
      const permissions = recordOf(settings.permissions);
      tools ||= listOf(permissions.allow).length > 0;
      outside ||= listOf(permissions.additionalDirectories).length > 0 || typeof settings.autoMemoryDirectory === "string";
      for (const name of listOf(settings.disabledMcpjsonServers)) disabled.add(name);
    }
  }
  const servers = new Map<string, unknown>();
  const walked = new Set<string>();
  for (const folder of places) {
    for (let dir = folder; !walked.has(dir); dir = dirname(dir)) {
      walked.add(dir);
      for (const [name, server] of Object.entries(recordOf(read(dir, CLAUDE_MCP_FILE).mcpServers))) if (!disabled.has(name) && !servers.has(name)) servers.set(name, server);
    }
  }
  helpers += [...servers.values()].filter((server) => typeof recordOf(server).headersHelper === "string").length;

  const runs = [counted(hooks, "hook"), counted(servers.size, "MCP server"), counted(helpers, "helper command"), env ? "env settings" : null].filter((part) => part !== null);
  const grants = [tools ? "use some tools without asking" : null, outside ? "reach folders outside it" : null].filter((part) => part !== null);
  const files = spoken([...new Set(unread.values())]);
  const lines: string[] = [];
  if (runs.length) lines.push(`This folder has ${spoken(runs)} that will run once you trust it.`);
  if (grants.length) lines.push(`${runs.length ? "Its settings also let" : "Once you trust it, this folder's settings let"} Claude Code ${spoken(grants)}.`);
  if (files) lines.push(lines.length ? `Its ${files} couldn't be read, so there may be more.` : `This folder's ${files} couldn't be read, so it may run something once you trust it.`);
  if (repository) lines.push(`This folder is part of the repository at ${repository.shown}; trusting it trusts that whole repository.`);

  const reaches = [tools ? "Uses tools without asking" : null, outside ? (tools ? "reaches outside folders" : "Reaches outside folders") : null].filter((part) => part !== null);
  const facts = [
    repository ? `Whole repository, not just ${repository.folder}` : null,
    runs.length ? `Runs ${runs.join(", ")}` : null,
    reaches.length ? reaches.join(", ") : null,
    unread.size ? `${counted(unread.size, "file")} couldn't be read` : null,
  ].filter((fact) => fact !== null);
  return { warning: lines.length ? lines.join(" ") : null, facts, warns: runs.length + grants.length + unread.size > 0 };
}
