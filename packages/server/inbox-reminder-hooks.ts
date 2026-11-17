/**
 * The Inbox reminder hooks Plannotator writes into an agent's own hook config
 * (packages/shared/inbox/reminder-hook.ts prints the text): one entry of ours,
 * running `plannotator inbox reminder --agent <id>`.
 *
 *  - Gemini CLI: `hooks.SessionStart` in `~/.gemini/settings.json` (startup,
 *    resume, clear; Gemini has no hook that adds context after a compaction).
 *  - Kiro: a file of our own, `~/.kiro/hooks/plannotator-inbox.json`, with a
 *    `SessionStart` and a `PostCompact` hook.
 *  - Codex: `hooks.SessionStart` in `$CODEX_HOME/hooks.json` (no matcher: every
 *    source, `compact` included). Codex runs a new hook only once the person
 *    approves it in its own `/hooks` screen; Plannotator never writes that
 *    approval. The connect line says so once (INBOX_CODEX_HOOK_HINT).
 *
 * Qwen Code's hook ships in our extension's hooks.json and Amp's in our plugin:
 * nothing to write here for them.
 *
 * The rules (as the MCP entries and notes): only our entry is written or
 * removed, losslessly (json-edit.ts: no other byte changes; anything else is
 * refused with the reason), atomically, at a symlink's target; a file that is
 * read-only or has other hard links is left alone; written once per agent (an
 * entry the person removed never comes back by itself); removal gives the file
 * back byte for byte while our entry is untouched (`undo`), and deletes a file
 * Plannotator created once only our entry was in it. Records:
 * `inbox/reminder-hooks.json`.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { loadConfig, resolveInboxReminder } from "@plannotator/shared/config";
import { inboxAgentReachedByRecord } from "@plannotator/shared/inbox/reminder-hook";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import { simpleShellCommandWords } from "@plannotator/shared/plannotator-tool";
import { describeFsError, readAgentFile, stripJsonComments, withBom, writeAgentFileAtomic } from "./agent-files";
import {
  agentHomeAllowed,
  agentSpec,
  codexHome,
  displayPath,
  geminiDir,
  textChange,
  type AgentEnvironment,
  type ConnectOptions,
  type JsonEntryUndo,
} from "./inbox-agents";
import { appendJsonArrayItem, removeJsonArrayItem, removeJsonMember } from "./json-edit";

/** The agents whose reminder hook Plannotator writes, in the order they are set up. */
export type InboxReminderHookAgent = "gemini" | "kiro" | "codex";
export const INBOX_REMINDER_HOOK_AGENTS: readonly InboxReminderHookAgent[] = ["gemini", "kiro", "codex"];

export const INBOX_REMINDER_HOOKS_FILE = "reminder-hooks.json";
/** Kiro's hook file, ours alone. */
export const KIRO_REMINDER_HOOK_FILE = "plannotator-inbox.json";
/** The name Gemini CLI and Kiro show for our hook (never sent to the model). */
export const INBOX_REMINDER_HOOK_NAME = "plannotator-inbox-reminder";

export interface InboxReminderHookRecord {
  /** The file written (its symlink target). */
  path: string;
  /** The command written. */
  command: string;
  /** The add's exact change, so removal gives the file back byte for byte. */
  undo?: JsonEntryUndo;
  /** Plannotator created the file. */
  created?: boolean;
  at: string;
  /** Our entry is no longer there: the person removed it, so it is never written again by itself. */
  removed_outside_at?: string;
}

interface InboxReminderHooksFile {
  v: 1;
  hooks: Partial<Record<InboxReminderHookAgent, InboxReminderHookRecord>>;
  /** The last reason each one could not be written (tried again at the next pass). */
  failures?: Partial<Record<InboxReminderHookAgent, string>>;
}

export function inboxReminderHooksPath(dataDir: string): string {
  return join(inboxDir(dataDir), INBOX_REMINDER_HOOKS_FILE);
}

export function readInboxReminderHooks(dataDir: string): InboxReminderHooksFile {
  try {
    const parsed = JSON.parse(readFileSync(inboxReminderHooksPath(dataDir), "utf8")) as Partial<InboxReminderHooksFile>;
    if (parsed?.v === 1 && parsed.hooks && typeof parsed.hooks === "object") return { v: 1, hooks: parsed.hooks, ...(parsed.failures ? { failures: parsed.failures } : {}) };
  } catch {
    // Missing or damaged: nothing recorded.
  }
  return { v: 1, hooks: {} };
}

function writeInboxReminderHooks(dataDir: string, file: InboxReminderHooksFile): void {
  mkdirSync(inboxDir(dataDir), { recursive: true, mode: 0o700 });
  writeAgentFileAtomic(inboxReminderHooksPath(dataDir), `${JSON.stringify(file, null, 2)}\n`, 0o600);
}

/** Where each agent's hook goes. */
export function inboxReminderHookPath(agent: InboxReminderHookAgent, e: AgentEnvironment): string {
  if (agent === "codex") return join(codexHome(e), "hooks.json");
  if (agent === "gemini") return join(geminiDir(e), "settings.json");
  return join(e.homeDir, ".kiro", "hooks", KIRO_REMINDER_HOOK_FILE);
}

/** `path` as the person knows it: where the agent's hook goes (`~/…`) when `path` is that file's target, else `path`. */
function shownPath(agent: InboxReminderHookAgent, path: string, e: AgentEnvironment): string {
  const usual = inboxReminderHookPath(agent, e);
  let same = usual === path;
  if (!same) {
    try {
      same = realpathSync(usual) === path;
    } catch {
      same = false;
    }
  }
  return displayPath(same ? usual : path, e) ?? path;
}

/** One argv word for a hook's shell command line. */
function shellWord(word: string, platform: NodeJS.Platform): string {
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(word)) return word;
  if (platform === "win32") return `"${word.replace(/"/g, '\\"')}"`;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The command our hook runs: this CLI, then `inbox reminder --agent <id>`. */
export function inboxReminderHookCommand(selfCommand: readonly string[], agent: InboxReminderHookAgent, platform: NodeJS.Platform): string {
  return [...selfCommand, "inbox", "reminder", "--agent", agent].map((word) => shellWord(word, platform)).join(" ");
}

/** A hook command that is ours: the one written, or any Plannotator CLI running `inbox reminder --agent <id>` (a moved binary, an older record). */
export function isInboxReminderHookCommand(command: unknown, agent: InboxReminderHookAgent, written?: string): boolean {
  if (typeof command !== "string") return false;
  if (written !== undefined && command === written) return true;
  const match = /^(?:"([^"]+)"|'([^']+)'|(\S+))\s+([\s\S]*)$/.exec(command.trim());
  if (!match) return false;
  const executable = match[1] ?? match[2] ?? match[3] ?? "";
  const name = basename(executable.replace(/\\/g, "/")).toLowerCase();
  const words = /[\r\n;&|<>`$]/.test(match[4] ?? "") ? null : simpleShellCommandWords(match[4] ?? "");
  if (!words) return false;
  // `plannotator …`, or a dev run (`bun <script> …`).
  const tail = name === "plannotator" || name === "plannotator.exe" ? words : name === "bun" || name === "bun.exe" ? words.slice(1) : null;
  return tail !== null && tail.join(" ") === `inbox reminder --agent ${agent}`;
}

/** The `hooks.SessionStart` entry written for Codex and Gemini CLI. Timeouts: seconds for Codex, milliseconds for Gemini CLI (their docs). */
export function inboxReminderHookEntry(agent: "codex" | "gemini", command: string): Record<string, unknown> {
  if (agent === "codex") return { hooks: [{ type: "command", command, timeout: 10 }] };
  return { matcher: "*", hooks: [{ name: INBOX_REMINDER_HOOK_NAME, type: "command", command, timeout: 10000 }] };
}

/** Kiro's file, ours alone: the reminder when a session starts and after each compaction. Timeout in seconds. */
export function kiroReminderHookFile(command: string): string {
  const hook = (trigger: string) => ({ name: INBOX_REMINDER_HOOK_NAME, trigger, action: { type: "command", command }, timeout: 10, enabled: true });
  return `${JSON.stringify({ version: "v1", hooks: [hook("SessionStart"), hook("PostCompact")] }, null, 2)}\n`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** The SessionStart entries that hold one of our hooks: their indexes, and whether ours is all they hold. */
function ourEntries(parsed: unknown, agent: InboxReminderHookAgent, written?: string): { index: number; only: boolean }[] {
  const list = asRecord(asRecord(parsed)?.hooks)?.SessionStart;
  if (!Array.isArray(list)) return [];
  const out: { index: number; only: boolean }[] = [];
  list.forEach((value, index) => {
    const hooks = asRecord(value)?.hooks;
    if (!Array.isArray(hooks)) return;
    const mine = hooks.filter((hook) => isInboxReminderHookCommand(asRecord(hook)?.command, agent, written));
    if (mine.length > 0) out.push({ index, only: mine.length === hooks.length });
  });
  return out;
}

/** Kiro's file holds only hooks of ours. */
function kiroFileIsOurs(text: string, written?: string): boolean {
  try {
    const parsed = asRecord(JSON.parse(text));
    const hooks = parsed?.hooks;
    return Array.isArray(hooks) && hooks.length > 0 && hooks.every((hook) => isInboxReminderHookCommand(asRecord(asRecord(hook)?.action)?.command, "kiro", written));
  } catch {
    return false;
  }
}

/** Why a file Plannotator did not create may not be written: read-only, or other hard links (the rename would split them). Null: it may. */
function writeRefusal(target: string, mode: number, shown: string): string | null {
  if ((mode & 0o200) === 0) return `${shown} is read-only`;
  try {
    if (statSync(target).nlink > 1) return `${shown} has other hard links`;
  } catch (error) {
    return `${shown} can't be read (${describeFsError(error)})`;
  }
  return null;
}

/** The bytes are still what was read (compare and write: an edit since the read is never lost). */
function stillReads(target: string, text: string, bom: boolean): boolean {
  try {
    return readFileSync(target).equals(Buffer.from(withBom(text, bom), "utf8"));
  } catch {
    return false;
  }
}

export type ReminderHookChange =
  | { ok: true; action: "added" | "present" | "removed" | "absent"; path: string; record?: InboxReminderHookRecord }
  | { ok: false; reason: string; path: string };

/** Write our hook for `agent` (no record is read or written here). */
export function addInboxReminderHook(agent: InboxReminderHookAgent, command: string, e: AgentEnvironment, at: string): ReminderHookChange {
  const path = inboxReminderHookPath(agent, e);
  const shown = shownPath(agent, path, e);
  const read = readAgentFile(path);
  if (read.kind === "refused") return { ok: false, reason: `${shown} can't be edited (${read.reason})`, path: shown };
  if (agent === "kiro") {
    const next = kiroReminderHookFile(command);
    if (read.kind === "file") {
      if (kiroFileIsOurs(read.text, command)) return { ok: true, action: "present", path: shown };
      return { ok: false, reason: `${shown} is not Plannotator's, so Plannotator left it as it was`, path: shown };
    }
    try {
      writeAgentFileAtomic(read.target, next, 0o644);
    } catch (error) {
      return { ok: false, reason: `${shown} can't be written (${describeFsError(error)})`, path: shown };
    }
    return { ok: true, action: "added", path: shown, record: { path: read.target, command, created: true, at } };
  }
  const comments = agent === "gemini";
  const original = read.kind === "file" ? read.text : "";
  if (original.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(comments ? stripJsonComments(original) : original);
    } catch {
      return { ok: false, reason: `${shown} is not ${comments ? "valid" : "plain"} JSON, so Plannotator left it as it was`, path: shown };
    }
    if (ourEntries(parsed, agent).length > 0) return { ok: true, action: "present", path: shown };
  }
  if (read.kind === "file") {
    const refusal = writeRefusal(read.target, read.mode, shown);
    if (refusal) return { ok: false, reason: refusal, path: shown };
  }
  const edit = appendJsonArrayItem(original, ["hooks"], "SessionStart", inboxReminderHookEntry(agent, command), { comments });
  if (!edit.ok) return { ok: false, reason: `${shown} can't be edited without reshaping it (${edit.reason}), so Plannotator left it as it was`, path: shown };
  const bom = read.kind === "file" && read.bom;
  if (read.kind === "file" ? !stillReads(read.target, original, bom) : existsSync(read.target)) {
    return { ok: false, reason: `${shown} changed while the hook was being added; tried again later`, path: shown };
  }
  try {
    writeAgentFileAtomic(read.target, withBom(edit.text, bom), read.kind === "file" ? read.mode : 0o644);
  } catch (error) {
    return { ok: false, reason: `${shown} can't be written (${describeFsError(error)})`, path: shown };
  }
  const created = read.kind === "missing";
  return { ok: true, action: "added", path: shown, record: { path: read.target, command, at, ...(created ? { created: true } : { undo: textChange(original, edit.text) }) } };
}

/**
 * Take our hook for `agent` out of `path` (its record's file, else where it
 * goes now): the add undone byte for byte while our entry is untouched, else
 * our entry alone cut out. A file Plannotator created goes once nothing but our
 * entry is in it. An entry that also holds the person's own hook is refused.
 */
export function removeInboxReminderHook(agent: InboxReminderHookAgent, e: AgentEnvironment, record?: InboxReminderHookRecord): ReminderHookChange {
  const path = record?.path ?? inboxReminderHookPath(agent, e);
  const shown = shownPath(agent, path, e);
  const read = readAgentFile(path);
  if (read.kind === "missing") return { ok: true, action: "absent", path: shown };
  if (read.kind === "refused") return { ok: false, reason: `${shown} can't be edited (${read.reason})`, path: shown };
  if (agent === "kiro") {
    if (!kiroFileIsOurs(read.text, record?.command)) return { ok: true, action: "absent", path: shown };
    try {
      rmSync(read.target, { force: true });
    } catch (error) {
      return { ok: false, reason: `${shown} can't be removed (${describeFsError(error)})`, path: shown };
    }
    return { ok: true, action: "removed", path: shown };
  }
  const comments = agent === "gemini";
  const original = read.text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(comments ? stripJsonComments(original) : original);
  } catch {
    return { ok: false, reason: `${shown} is not ${comments ? "valid" : "plain"} JSON, so Plannotator left it as it was`, path: shown };
  }
  const entries = ourEntries(parsed, agent, record?.command);
  if (entries.length === 0) return { ok: true, action: "absent", path: shown };
  if (entries.some((entry) => !entry.only)) return { ok: false, reason: `${shown} has another hook beside Plannotator's in one entry, so Plannotator left it as it was`, path: shown };
  let next: string | null = null;
  // The add undone exactly: the text it added appears once, and putting back what was there leaves none of ours.
  if (record?.undo?.after && record.undo.after.includes(JSON.stringify(record.command))) {
    const first = original.indexOf(record.undo.after);
    if (first >= 0 && original.indexOf(record.undo.after, first + 1) < 0) {
      const restored = original.slice(0, first) + record.undo.before + original.slice(first + record.undo.after.length);
      try {
        if (!restored.trim() || ourEntries(JSON.parse(comments ? stripJsonComments(restored) : restored), agent, record.command).length === 0) next = restored;
      } catch {
        next = null;
      }
    }
  }
  if (next === null) {
    let text = original;
    // From the last, so the indexes before it still hold.
    for (const entry of [...entries].reverse()) {
      const cut = removeJsonArrayItem(text, ["hooks"], "SessionStart", entry.index, { comments });
      if (!cut.ok) return { ok: false, reason: `${shown} can't be edited without reshaping it (${cut.reason}), so Plannotator left it as it was`, path: shown };
      text = cut.text;
    }
    const list = asRecord(asRecord(JSON.parse(comments ? stripJsonComments(text) : text))?.hooks)?.SessionStart;
    if (Array.isArray(list) && list.length === 0) {
      const dropped = removeJsonMember(text, ["hooks"], "SessionStart", { comments });
      if (dropped.ok) text = dropped.text;
    }
    next = text;
  }
  const refusal = writeRefusal(read.target, read.mode, shown);
  if (refusal) return { ok: false, reason: refusal, path: shown };
  if (record?.created && isOnlyEmptyHooks(next, comments)) {
    try {
      rmSync(read.target, { force: true });
    } catch (error) {
      return { ok: false, reason: `${shown} can't be removed (${describeFsError(error)})`, path: shown };
    }
    return { ok: true, action: "removed", path: shown };
  }
  if (!stillReads(read.target, original, read.bom)) return { ok: false, reason: `${shown} changed while the hook was being removed; try again`, path: shown };
  try {
    writeAgentFileAtomic(read.target, withBom(next, read.bom), read.mode);
  } catch (error) {
    return { ok: false, reason: `${shown} can't be written (${describeFsError(error)})`, path: shown };
  }
  return { ok: true, action: "removed", path: shown };
}

/** Nothing left but `{}` or `{ "hooks": {} }`. */
function isOnlyEmptyHooks(text: string, comments: boolean): boolean {
  if (!text.trim()) return true;
  try {
    const parsed = JSON.stringify(JSON.parse(comments ? stripJsonComments(text) : text));
    return parsed === "{}" || parsed === '{"hooks":{}}';
  } catch {
    return false;
  }
}

/**
 * Write the reminder hook for each agent that should have one and was never
 * given one: found here, reaching the Inbox (its record), its reminder on. Once
 * written it is recorded; an entry the person removed is noted and never added
 * again by itself. Returns the agents whose hook this pass added. Nothing in a
 * test whose home is not a scratch folder.
 */
export function syncInboxReminderHooks(options: ConnectOptions): InboxReminderHookAgent[] {
  const e = options.environment;
  if (!agentHomeAllowed(e)) return [];
  const config = loadConfig({ quiet: true });
  const file = readInboxReminderHooks(options.dataDir);
  const at = (options.now ?? (() => new Date()))().toISOString();
  const added: InboxReminderHookAgent[] = [];
  let changed = false;
  for (const agent of INBOX_REMINDER_HOOK_AGENTS) {
    const record = file.hooks[agent];
    if (record) {
      if (record.removed_outside_at) continue;
      // Still there? A person who took it out keeps it out.
      const read = readAgentFile(record.path);
      const there =
        read.kind === "file" &&
        (agent === "kiro"
          ? kiroFileIsOurs(read.text, record.command)
          : (() => {
              try {
                return ourEntries(JSON.parse(agent === "gemini" ? stripJsonComments(read.text) : read.text), agent, record.command).length > 0;
              } catch {
                return true;
              }
            })());
      if (!there && read.kind !== "refused") {
        file.hooks[agent] = { ...record, removed_outside_at: at };
        changed = true;
      }
      continue;
    }
    if (!agentSpec(agent).detect(e) || !inboxAgentReachedByRecord(options.dataDir, agent)) continue;
    if (!resolveInboxReminder(config, e.env as NodeJS.ProcessEnv, agent)) continue;
    const command = inboxReminderHookCommand(options.selfCommand, agent, e.platform);
    const change = addInboxReminderHook(agent, command, e, at);
    if (!change.ok) {
      if (file.failures?.[agent] !== change.reason) {
        (file.failures ??= {})[agent] = change.reason;
        changed = true;
      }
      continue;
    }
    if (file.failures?.[agent]) {
      delete file.failures[agent];
      changed = true;
    }
    // One that was already there (the person's copy, or an older Inbox's with no record) is theirs: not recorded, never removed by Settings.
    if (change.action === "added" && change.record) {
      file.hooks[agent] = change.record;
      added.push(agent);
      changed = true;
    }
  }
  if (changed) writeInboxReminderHooks(options.dataDir, file);
  return added;
}

/** The person turned the agent off in Settings: our hook goes (only the recorded one), and so does its record. Returns an error reason, or null. */
export function removeRecordedInboxReminderHook(agent: string, options: Pick<ConnectOptions, "dataDir" | "environment">): string | null {
  if (!(INBOX_REMINDER_HOOK_AGENTS as readonly string[]).includes(agent)) return null;
  const id = agent as InboxReminderHookAgent;
  const file = readInboxReminderHooks(options.dataDir);
  const record = file.hooks[id];
  if (!record) return null;
  if (!record.removed_outside_at) {
    const change = removeInboxReminderHook(id, options.environment, record);
    if (!change.ok) return `Plannotator's reminder hook in ${change.path} could not be removed (${change.reason})`;
  }
  delete file.hooks[id];
  writeInboxReminderHooks(options.dataDir, file);
  return null;
}

/** For `plannotator uninstall`: our reminder hooks, recorded or found where they go. */
export interface ReminderHookRemovalItem {
  agent: InboxReminderHookAgent;
  describe: string;
  apply: () => string | null;
}

export function planInboxReminderHookRemoval(dataDir: string, e: AgentEnvironment): ReminderHookRemovalItem[] {
  if (!agentHomeAllowed(e)) return [];
  const file = readInboxReminderHooks(dataDir);
  const items: ReminderHookRemovalItem[] = [];
  for (const agent of INBOX_REMINDER_HOOK_AGENTS) {
    const record = file.hooks[agent];
    const path = record?.path ?? inboxReminderHookPath(agent, e);
    const read = readAgentFile(path);
    if (read.kind !== "file") continue;
    const present =
      agent === "kiro"
        ? kiroFileIsOurs(read.text, record?.command)
        : (() => {
            try {
              return ourEntries(JSON.parse(agent === "gemini" ? stripJsonComments(read.text) : read.text), agent, record?.command).length > 0;
            } catch {
              return false;
            }
          })();
    if (!present) continue;
    const shown = shownPath(agent, path, e);
    items.push({
      agent,
      describe: `Plannotator's Inbox reminder hook in ${shown}`,
      apply: () => {
        const change = removeInboxReminderHook(agent, e, record);
        if (!change.ok) return change.reason;
        const now = readInboxReminderHooks(dataDir);
        if (now.hooks[agent]) {
          delete now.hooks[agent];
          try {
            writeInboxReminderHooks(dataDir, now);
          } catch {
            // Best effort: the data folder may be going too.
          }
        }
        return null;
      },
    });
  }
  return items;
}
