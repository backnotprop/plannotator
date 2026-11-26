/**
 * send_message's `links_not_found`: links in the body (`[text](path)`, outside code) to a file that opens nothing in
 * the window, because there is no file where the window looks for it. Where it looks is the referenced-file view's
 * own order (inbox-open-in.ts `inboxMessageCandidates`, then inbox-link-fallback.ts: a file of that name the thread
 * was handed, the same sender's earlier folders). A warning in the result, never a refusal: the message is sent.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { checkInboxReadableFile } from "@plannotator/shared/inbox/attachments";
import { blankCode } from "@plannotator/shared/inbox/message-images";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxMessageCandidates } from "./inbox-open-in";
import { earlierSenderPlaces, sameNamedAttachment } from "./inbox-link-fallback";

/** The most links the warning names (the structured list and the text alike); the rest are counted. */
export const LINKS_NOT_FOUND_MAX = 10;
/** The most links one send looks for on disk. */
const LINKS_CHECKED_MAX = 50;

export interface LinkNotFound {
  /** The link as written in the body. */
  ref: string;
  /** Where the window looks for it first: the folder the message was sent from. */
  path: string;
}

/** A markdown link (never an image), its target as group 1: `<…>` or a run without spaces, balanced parentheses allowed. */
const MARKDOWN_LINK_RE = /(?<![!\\])\[[^\]\n]*\]\(\s*(<[^>\n]*>|[^\s()<>]+(?:\([^\s()]*\)[^\s()<>]*)*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;

/**
 * The local file paths the body's links name, each once, in text order, as the window asks the server about them:
 * without `?`/`#`, percent-decoded, without a `:12` line suffix. Web links, `#anchors`, any scheme, and folders
 * (ending in `/`) are left out.
 */
export function bodyFileLinks(body: string): { ref: string; path: string }[] {
  const out = new Map<string, string>();
  for (const match of blankCode(body).matchAll(MARKDOWN_LINK_RE)) {
    let target = match[1]!.trim();
    if (target.startsWith("<")) target = target.slice(1, -1).trim();
    if (target === "" || target.startsWith("#") || target.startsWith("//") || target.startsWith("\\\\")) continue;
    if (!/^[a-z]:[\\/]/i.test(target) && /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    let path = target.replace(/[?#].*$/s, "");
    if (path.includes("%")) {
      try {
        path = decodeURIComponent(path);
      } catch {
        // Not percent-encoded after all.
      }
    }
    path = path.replace(/:\d+(?:-\d+|:\d+)?$/, "");
    if (path === "" || /[\\/]$/.test(path) || out.has(path)) continue;
    out.set(path, target);
  }
  return [...out].map(([path, ref]) => ({ ref, path }));
}

/** The body's links of a sent message that open nothing: no file where the window would look, nor one of that name the thread was handed. */
export async function linksNotFound(store: InboxStore, message: { id: string; thread_id: string; body: string }, home = homedir()): Promise<LinkNotFound[]> {
  const scope = { thread: message.thread_id, message: message.id };
  const out: LinkNotFound[] = [];
  for (const { ref, path } of bodyFileLinks(message.body).slice(0, LINKS_CHECKED_MAX)) {
    const places = inboxMessageCandidates(store, home, home, scope, path);
    if (places.length === 0 || sameNamedAttachment(store, scope, path)) continue;
    const all = [...new Set([...places, ...earlierSenderPlaces(store, scope, path)])];
    const file = await checkInboxReadableFile(all, () => false);
    // Something is there (a file, or one the window refuses to show and says so): not this warning's.
    if (file.ok || file.code === "refused" || all.some((place) => existsSync(place))) continue;
    out.push({ ref, path: places[0]! });
  }
  return out;
}

/** The send tools' warning sentence, or "" when every link opens a file. Appended to the result text. */
export function linksNotFoundText(list: readonly LinkNotFound[]): string {
  if (list.length === 0) return "";
  const named = list
    .slice(0, LINKS_NOT_FOUND_MAX)
    .map(({ ref, path }) => `${ref} (no file at ${path})`)
    .join("; ");
  const more = list.length > LINKS_NOT_FOUND_MAX ? `; …and ${list.length - LINKS_NOT_FOUND_MAX} more` : "";
  return ` The message was sent, but ${list.length === 1 ? "this link opens nothing" : `${list.length} links open nothing`}: ${named}${more}. Attach the file with attachments, or link its absolute path.`;
}
