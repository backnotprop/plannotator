/**
 * The file a relative link in an agent's message means when it is not where the message's own folder says
 * (`base_path` follows the agent's shell, so the same link text in two messages of one thread may start in two
 * folders). The referenced-file view (inbox-open-in.ts) asks these after the message's own places miss, and the send
 * asks them before it warns (`links_not_found`):
 *
 *   1. a file the message itself attached under that name (or ending in that relative path);
 *   2. the newest such file attached by an earlier message of the same thread;
 *   3. the link from the folder each earlier message of the same sender was sent from, newest first.
 *
 * The thread's project folder is already one of the message's own places. Nothing here widens what is read: an
 * attachment is the thread's own kept copy, and a folder of step 3 is a candidate path that goes through the same
 * readable-file checks and reach as any other.
 */
import { join, posix } from "node:path";
import type { InboxStore } from "@plannotator/shared/inbox/store";

type ThreadMessage = NonNullable<ReturnType<InboxStore["thread"]>>["messages"][number];

/** A link as written, cleaned to a relative path with forward slashes; null for an absolute or `~` path. */
export function relativeLinkPath(named: string): string | null {
  if (typeof named !== "string" || named === "" || named.length > 4096) return null;
  if (/^~(?:[\\/]|$)/.test(named) || named.startsWith("/") || named.startsWith("\\") || /^[a-z]:[\\/]/i.test(named)) return null;
  const clean = posix.normalize(named.replace(/\\/g, "/")).replace(/^(?:\.\/)+/, "");
  return clean === "" || clean === "." ? null : clean;
}

/** The link's own part, past any `../`: what an attached file's path must end with. */
function tailOf(clean: string): string {
  return clean.replace(/^(?:\.\.\/)+/, "");
}

function attachmentMeans(attachment: { name: string; path: string; named_path?: string | null }, tail: string): boolean {
  if (tail === "") return false;
  if (!tail.includes("/")) return attachment.name === tail || posix.basename(attachment.path.replace(/\\/g, "/")) === tail;
  return [attachment.path, attachment.named_path ?? ""].some((path) => path !== "" && path.replace(/\\/g, "/").endsWith(`/${tail}`));
}

/** The thread's messages up to and including `messageId`, newest first: [] when that message is not in that thread. */
function upTo(store: InboxStore, threadId: unknown, messageId: unknown): ThreadMessage[] {
  if (typeof threadId !== "string" || typeof messageId !== "string") return [];
  const messages = store.thread(threadId)?.messages ?? [];
  const at = messages.findIndex((message) => message.id === messageId);
  return at < 0 ? [] : messages.slice(0, at + 1).reverse();
}

/** The attachment a relative link means when it is not on disk where the message says: its own first, then the newest earlier one. */
export function sameNamedAttachment(store: InboxStore, scope: { thread?: unknown; message?: unknown }, named: string): string | null {
  const clean = relativeLinkPath(named);
  if (!clean) return null;
  const tail = tailOf(clean);
  for (const message of upTo(store, scope.thread, scope.message)) {
    const hit = (message.attachments ?? []).find((attachment) => attachmentMeans(attachment, tail));
    if (hit) return hit.id;
  }
  return null;
}

function sameSender(a: ThreadMessage["author"], b: ThreadMessage["author"]): boolean {
  if (a.kind !== "agent" || b.kind !== "agent") return false;
  const first = a as { session?: string | null; host?: string | null; name?: string | null };
  const second = b as { session?: string | null; host?: string | null; name?: string | null };
  if (first.session && second.session) return first.session === second.session;
  return (first.host ?? null) === (second.host ?? null) && (first.name ?? null) === (second.name ?? null);
}

/** The link from the folders earlier messages of the same sender in the thread were sent from, newest first (never the message's own). */
export function earlierSenderPlaces(store: InboxStore, scope: { thread?: unknown; message?: unknown }, named: string): string[] {
  const clean = relativeLinkPath(named);
  if (!clean) return [];
  const [own, ...earlier] = upTo(store, scope.thread, scope.message);
  if (!own) return [];
  const bases = earlier.filter((message) => sameSender(message.author, own.author)).map((message) => message.base_path ?? null);
  return [...new Set(bases.filter((base): base is string => typeof base === "string" && base !== "" && base !== own.base_path).map((base) => join(base, clean)))];
}
