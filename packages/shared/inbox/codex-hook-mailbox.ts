/**
 * The Codex hook's mailbox: replies the Inbox holds for a Codex thread that is in a turn, for Plannotator's Codex
 * `PostToolUse` hook (`plannotator codex-hook`) to put into that turn after its next tool call. The route for a Codex
 * the Inbox cannot reach over Codex's control socket (the Codex app, a TUI started with `--no-daemon`): see
 * packages/server/inbox-codex-steer.ts.
 *
 * Files only, under the Inbox's folder (`<data dir>/inbox/`), so the hook needs no request to the Inbox:
 *
 *  - `codex-hook/<thread id>.<item id>.json` — `{ "at": <ms>, "text": <the wake text> }`, written by the Inbox. The
 *    folder is empty whenever nothing waits, which the installed hook command tests in its own shell before it starts
 *    the binary at all (`CODEX_HOOK_GATE`), so a tool call costs a glob when nothing waits.
 *  - The claim is the Codex wake's own: the folder `codex-queue/<item id>.<thread id>/`, made with mkdir. Whoever
 *    makes it sends the text, the hook or `codex queue`, never both. The hook then writes `hooked.json` in it, which
 *    the Inbox reads as delivered into the running turn.
 */

import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

/** The mailbox folder under the Inbox's folder. */
export const CODEX_HOOK_DIR = "codex-hook";
/** The Codex wake's claims under the Inbox's folder (inbox-codex-wake.ts). */
export const CODEX_QUEUE_DIR = "codex-queue";
/** Written in a claim the hook made: it put the text into the running turn. */
export const CODEX_HOOKED_FILE = "hooked.json";
/** The longest context the hook hands Codex at once (several replies together stay under one `codex queue` text's cap). */
export const CODEX_HOOK_CONTEXT_MAX_BYTES = 200_000;

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ITEM_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const codexHookClaimDir = (inboxDir: string, itemId: string, thread: string) => join(inboxDir, CODEX_QUEUE_DIR, `${itemId}.${thread}`);
const heldFile = (inboxDir: string, thread: string, itemId: string) => join(inboxDir, CODEX_HOOK_DIR, `${thread}.${itemId}.json`);

/** Hold `text` for the thread's hook (the Inbox). Replaces nothing a hook already took: a claimed item is never held. */
export function holdForCodexHook(inboxDir: string, thread: string, itemId: string, text: string, at: number): void {
  if (!THREAD_ID.test(thread) || !ITEM_ID.test(itemId)) throw new Error("not a Codex thread id or an item id");
  const dir = join(inboxDir, CODEX_HOOK_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Written whole under another name first: the hook never reads half a file.
  const temp = join(dir, `.${thread}.${itemId}.${process.pid}.tmp`);
  writeFileSync(temp, `${JSON.stringify({ at, text })}\n`, { mode: 0o600 });
  renameSync(temp, heldFile(inboxDir, thread, itemId));
}

/** No longer held (the Inbox: it went another way, or the hook took it). */
export function releaseCodexHookHold(inboxDir: string, thread: string, itemId: string): void {
  rmSync(heldFile(inboxDir, thread, itemId), { force: true });
}

/** The items held for `thread`, oldest first. */
export function codexHookHeld(inboxDir: string, thread: string): { itemId: string; at: number; text: string }[] {
  let names: string[];
  try {
    names = readdirSync(join(inboxDir, CODEX_HOOK_DIR));
  } catch {
    return [];
  }
  const prefix = `${thread.toLowerCase()}.`;
  const held: { itemId: string; at: number; text: string }[] = [];
  for (const name of names) {
    if (!name.toLowerCase().startsWith(prefix) || !name.endsWith(".json")) continue;
    const itemId = name.slice(prefix.length, -".json".length);
    if (!ITEM_ID.test(itemId)) continue;
    try {
      const record = JSON.parse(readFileSync(join(inboxDir, CODEX_HOOK_DIR, name), "utf8")) as { at?: unknown; text?: unknown };
      if (typeof record.text === "string" && typeof record.at === "number") held.push({ itemId, at: record.at, text: record.text });
    } catch {
      // Gone meanwhile, or not ours.
    }
  }
  return held.sort((a, b) => a.at - b.at || a.itemId.localeCompare(b.itemId));
}

/** When the hook put the item into a turn (`hooked.json` in its claim), or null. */
export function codexHookedAt(inboxDir: string, itemId: string, thread: string): number | null {
  try {
    const record = JSON.parse(readFileSync(join(codexHookClaimDir(inboxDir, itemId, thread), CODEX_HOOKED_FILE), "utf8")) as { at?: unknown };
    return typeof record.at === "number" ? record.at : null;
  } catch {
    return null;
  }
}

/**
 * The hook: claim every item held for `thread` that no one claimed yet, and return their texts in order (empty when
 * none). Each claim is the wake's own mkdir, so an item `codex queue` took is skipped, and one the hook takes is never
 * queued. Texts past CODEX_HOOK_CONTEXT_MAX_BYTES stay held for the next tool call.
 */
export function takeForCodexHook(inboxDir: string, thread: string, now: number): string[] {
  if (!THREAD_ID.test(thread)) return [];
  const texts: string[] = [];
  let bytes = 0;
  for (const one of codexHookHeld(inboxDir, thread)) {
    const size = Buffer.byteLength(one.text);
    if (texts.length > 0 && bytes + size > CODEX_HOOK_CONTEXT_MAX_BYTES) break;
    const claim = codexHookClaimDir(inboxDir, one.itemId, thread);
    try {
      mkdirSync(join(inboxDir, CODEX_QUEUE_DIR), { recursive: true });
      mkdirSync(claim);
    } catch {
      // Claimed already: `codex queue` (or another hook run) has it.
      continue;
    }
    // Said before the text goes out: the Inbox reads it as delivered into the turn.
    const fd = openSync(join(claim, CODEX_HOOKED_FILE), "w", 0o600);
    try {
      writeSync(fd, `${JSON.stringify({ at: now })}\n`);
    } finally {
      closeSync(fd);
    }
    releaseCodexHookHold(inboxDir, thread, one.itemId);
    texts.push(one.text);
    bytes += size;
  }
  return texts;
}

/** The hook's answer to Codex for the texts it took: `additionalContext` after the tool call (one string). */
export function codexHookOutput(texts: readonly string[]): string {
  if (texts.length === 0) return "";
  return `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: texts.join("\n\n") } })}\n`;
}
