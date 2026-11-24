/**
 * The Codex hook's mailbox: replies the Inbox holds for a Codex thread that is in a turn, for Plannotator's Codex
 * `PostToolUse` hook (`plannotator codex-hook`) to put into that turn after its next tool call (the Codex app, any
 * Codex that runs hooks; only with the experimental `codex-steer` switch on): see packages/server/inbox-codex-steer.ts.
 *
 * Files only, under the Inbox's folder (`<data dir>/inbox/`), so the hook needs no request to the Inbox:
 *
 *  - `codex-hook/<thread id>.<item id>.json` — `{ "at": <ms>, "text": <the wake text>, "sight": <where the Inbox looks
 *    for it in the thread's rollout> }`, written by the Inbox. The folder is empty whenever nothing waits, which the
 *    installed hook command tests in its own shell before it starts the binary at all, and it starts the binary only
 *    for a tool call of a thread with a file here (packages/shared/codex-hook-command.ts).
 *  - The claim is the Codex wake's own: the folder `codex-queue/<item id>.<thread id>/`, made with mkdir. Whoever
 *    makes it sends the text, the hook or `codex queue`, never both. The hook then writes `hooked.json` in it (the
 *    held file's `sight`), which the Inbox reads as handed to the running turn: it says Delivered only once the
 *    thread's rollout shows the text (packages/server/inbox-codex-sight.ts), and sends it as the next turn when the
 *    turn ended without it (the person pressed Esc during the hook, or the hook ran out of time).
 *  - `codex-hook-ran`: rewritten by the hook's gate when Codex runs it (packages/shared/codex-hook-command.ts).
 */

import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { CODEX_HOOK_RAN_FILE } from "../codex-hook-command";

/** The mailbox folder under the Inbox's folder. */
export const CODEX_HOOK_DIR = "codex-hook";
/** The Codex wake's claims under the Inbox's folder (inbox-codex-wake.ts). */
export const CODEX_QUEUE_DIR = "codex-queue";
/** Written in a claim the hook made: it handed the text to the running turn. */
export const CODEX_HOOKED_FILE = "hooked.json";
/** The hook's mark in a claim it made (empty), written before `hooked.json`. */
export const CODEX_HOOK_CLAIM_MARK = "hook-claim";
/**
 * In the claims folder (`codex-queue/`): written by an Inbox that starts with the switch on, taken out (with every
 * held file and `next-turn` record) by one that starts with it off. Without it the hook takes nothing. An Inbox
 * started with the switch off reads the claims folder anyway, so it sees this with no new file work.
 */
export const CODEX_STEER_ON_FILE = "steer-on";
/**
 * In the claims folder: one empty file per reply (`<item id>.<thread id>`) that goes only as the next turn from now on
 * (it was steered once, or a turn ended without it). Kept across a restart, so a reply is steered at most once.
 */
export const CODEX_NEXT_TURN_DIR = "next-turn";

/** Whether the last Inbox to start on this folder had the switch on (`steer-on`). */
export function codexSteerMarked(inboxDir: string): boolean {
  try {
    statSync(join(inboxDir, CODEX_QUEUE_DIR, CODEX_STEER_ON_FILE));
    return true;
  } catch {
    return false;
  }
}

/**
 * The most the hook hands Codex at once, in bytes. Codex shortens an `additionalContext` past about 2,500 tokens to a
 * preview and a temp file's path, so a reply this route cannot carry whole goes as the next turn (`codex queue`).
 */
export const CODEX_HOOK_CONTEXT_MAX_BYTES = 8 * 1024;
/** The same limit in tokens, counted high (a character outside ASCII as one token, four ASCII bytes as one). */
const CODEX_HOOK_CONTEXT_MAX_TOKENS = 2_000;

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ITEM_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Where the Inbox looks in the thread's rollout for a text it handed on (packages/server/inbox-codex-sight.ts). */
export interface CodexSightStart {
  /** The rollout file. */
  rollout: string;
  /** Its size when the text was handed on (nothing of it can be before). */
  offset: number;
  /** The turn that ran then (its rollout `turn_id`), or null when the rollout did not say. */
  turn: string | null;
}

/** Where to look, and what for: the text's first line (`Plannotator Inbox: <title> (<id>)`) and the id in it. */
export interface CodexSight extends CodexSightStart {
  line: string;
  id: string;
}

/** A held reply. */
export interface CodexHookHeld {
  itemId: string;
  at: number;
  text: string;
  sight: CodexSight | null;
}

/** What the hook wrote when it took one (`hooked.json`). */
export interface CodexHooked {
  at: number;
  sight: CodexSight | null;
}

export const codexHookClaimDir = (inboxDir: string, itemId: string, thread: string) => join(inboxDir, CODEX_QUEUE_DIR, `${itemId}.${thread}`);
const heldFile = (inboxDir: string, thread: string, itemId: string) => join(inboxDir, CODEX_HOOK_DIR, `${thread.toLowerCase()}.${itemId}.json`);

/** Whether `text` fits the hook's context whole (CODEX_HOOK_CONTEXT_MAX_BYTES). */
export function codexHookFits(text: string): boolean {
  const bytes = Buffer.byteLength(text);
  if (bytes > CODEX_HOOK_CONTEXT_MAX_BYTES) return false;
  let ascii = 0;
  let other = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 0x80) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 4) + other <= CODEX_HOOK_CONTEXT_MAX_TOKENS;
}

/** A sight record as written (`steered.json`, a held file, `hooked.json`), or null. */
export function codexSightOf(value: unknown): CodexSight | null {
  const record = value as { rollout?: unknown; offset?: unknown; turn?: unknown; line?: unknown; id?: unknown } | null | undefined;
  if (!record || typeof record.rollout !== "string" || typeof record.offset !== "number" || typeof record.line !== "string" || typeof record.id !== "string") return null;
  return { rollout: record.rollout, offset: record.offset, turn: typeof record.turn === "string" ? record.turn : null, line: record.line, id: record.id };
}
const sightOf = codexSightOf;

/** Hold `text` for the thread's hook (the Inbox). Replaces nothing a hook already took: a claimed item is never held. */
export function holdForCodexHook(inboxDir: string, thread: string, itemId: string, text: string, at: number, sight: CodexSight | null = null): void {
  if (!THREAD_ID.test(thread) || !ITEM_ID.test(itemId)) throw new Error("not a Codex thread id or an item id");
  const dir = join(inboxDir, CODEX_HOOK_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Written whole under another name first: the hook never reads half a file.
  const temp = join(dir, `.${thread.toLowerCase()}.${itemId}.${process.pid}.tmp`);
  writeFileSync(temp, `${JSON.stringify({ at, text, sight })}\n`, { mode: 0o600 });
  renameSync(temp, heldFile(inboxDir, thread, itemId));
}

/** No longer held (the Inbox: it went another way, or the hook took it). */
export function releaseCodexHookHold(inboxDir: string, thread: string, itemId: string): void {
  rmSync(heldFile(inboxDir, thread, itemId), { force: true });
}

/** Every held file, as `<thread id>.<item id>` (lower-case thread), and the names that are no held file of ours. */
function heldNames(inboxDir: string): { key: string; name: string }[] {
  let names: string[];
  try {
    names = readdirSync(join(inboxDir, CODEX_HOOK_DIR));
  } catch {
    return [];
  }
  const out: { key: string; name: string }[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const dot = name.indexOf(".");
    const thread = name.slice(0, dot);
    const itemId = name.slice(dot + 1, -".json".length);
    if (THREAD_ID.test(thread) && ITEM_ID.test(itemId)) out.push({ key: `${itemId}.${thread.toLowerCase()}`, name });
  }
  return out;
}

/**
 * Clear every held file whose `<item id>.<thread id>` (lower-case thread) is not in `keep` (the Inbox: at start, when
 * nothing is held yet, and on each look, so a file left by a stopped Inbox never enters an unrelated turn, nor makes
 * the gate start the binary). Returns the keys it cleared.
 */
export function clearCodexHookHolds(inboxDir: string, keep: ReadonlySet<string>): string[] {
  const cleared: string[] = [];
  for (const { key, name } of heldNames(inboxDir)) {
    if (keep.has(key)) continue;
    rmSync(join(inboxDir, CODEX_HOOK_DIR, name), { force: true });
    cleared.push(key);
  }
  return cleared;
}

/** The items held for `thread`, oldest first. */
export function codexHookHeld(inboxDir: string, thread: string): CodexHookHeld[] {
  const lower = thread.toLowerCase();
  const held: CodexHookHeld[] = [];
  for (const { key, name } of heldNames(inboxDir)) {
    if (!key.endsWith(`.${lower}`)) continue;
    try {
      const record = JSON.parse(readFileSync(join(inboxDir, CODEX_HOOK_DIR, name), "utf8")) as { at?: unknown; text?: unknown; sight?: unknown };
      if (typeof record.text === "string" && typeof record.at === "number") held.push({ itemId: key.slice(0, key.indexOf(".")), at: record.at, text: record.text, sight: sightOf(record.sight) });
    } catch {
      // Gone meanwhile, or not ours.
    }
  }
  return held.sort((a, b) => a.at - b.at || a.itemId.localeCompare(b.itemId));
}

/** Whether the claim of `itemId` for `thread` is the hook's (its mark, written right after its mkdir). */
export function codexHookClaimed(inboxDir: string, itemId: string, thread: string): boolean {
  try {
    statSync(join(codexHookClaimDir(inboxDir, itemId, thread), CODEX_HOOK_CLAIM_MARK));
    return true;
  } catch {
    return false;
  }
}

/** What the hook wrote when it took the item (`hooked.json` in its claim), or null. */
export function codexHooked(inboxDir: string, itemId: string, thread: string): CodexHooked | null {
  try {
    const record = JSON.parse(readFileSync(join(codexHookClaimDir(inboxDir, itemId, thread), CODEX_HOOKED_FILE), "utf8")) as { at?: unknown; sight?: unknown };
    return typeof record.at === "number" ? { at: record.at, sight: sightOf(record.sight) } : null;
  } catch {
    return null;
  }
}

/**
 * The hook: claim every item held for `thread` that no one claimed yet, and return their texts in order (empty when
 * none). Each claim is the wake's own mkdir, so an item `codex queue` took is skipped, and one the hook takes is never
 * queued. Texts past CODEX_HOOK_CONTEXT_MAX_BYTES together stay held for the next tool call.
 */
export function takeForCodexHook(inboxDir: string, thread: string, now: number): string[] {
  if (!THREAD_ID.test(thread)) return [];
  const texts: string[] = [];
  for (const one of codexHookHeld(inboxDir, thread)) {
    if (texts.length > 0 && !codexHookFits([...texts, one.text].join("\n\n"))) break;
    const claim = codexHookClaimDir(inboxDir, one.itemId, thread);
    try {
      mkdirSync(join(inboxDir, CODEX_QUEUE_DIR), { recursive: true });
      mkdirSync(claim);
    } catch {
      // Claimed already: `codex queue` (or another hook run) has it.
      continue;
    }
    // The hook's own mark, at once: the Inbox treats a claim as the hook's only with it (never another Inbox's).
    writeFileSync(join(claim, CODEX_HOOK_CLAIM_MARK), "", { mode: 0o600 });
    // Said before the text goes out: the Inbox then looks for it in the rollout (never Delivered before it is there).
    const fd = openSync(join(claim, CODEX_HOOKED_FILE), "w", 0o600);
    try {
      writeSync(fd, `${JSON.stringify({ at: now, sight: one.sight })}\n`);
    } finally {
      closeSync(fd);
    }
    releaseCodexHookHold(inboxDir, thread, one.itemId);
    texts.push(one.text);
  }
  return texts;
}

/** The hook's answer to Codex for the texts it took: `additionalContext` after the tool call (one string). */
export function codexHookOutput(texts: readonly string[]): string {
  if (texts.length === 0) return "";
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: texts.join("\n\n") } })}\n`;
}

/** The binary: Codex ran the hook (the gate does the same; this covers a run the gate left to the binary). */
export function noteCodexHookRan(inboxDir: string, now: number): void {
  const file = join(inboxDir, CODEX_HOOK_RAN_FILE);
  try {
    const at = new Date(now);
    try {
      utimesSync(file, at, at);
    } catch {
      writeFileSync(file, "", { mode: 0o600 });
    }
  } catch {
    // No Inbox folder: nothing to note.
  }
}

/** Since when Codex is known to run the hook (the note's mtime, ms), or null when it never has. */
export function codexHookRanAt(inboxDir: string): number | null {
  try {
    return statSync(join(inboxDir, CODEX_HOOK_RAN_FILE)).mtimeMs;
  } catch {
    return null;
  }
}
