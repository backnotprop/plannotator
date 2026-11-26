/**
 * The file a relative link in an agent's message means when it is not where the message's own folder says
 * (`base_path` follows the agent's shell, so the same link text in two messages of one thread may start in two
 * folders). Every route that opens a link asks this after the message's own places miss (inbox-open-in.ts: the pane's
 * view, its raw bytes, the attach, the hover and Open in), and the send asks it before it warns (`links_not_found`):
 *
 *   1. a file the message itself attached under that name (or ending in that relative path);
 *   2. such a file an earlier message of the same sender in this thread attached, newest first;
 *   3. the link from the folder each earlier message of the same sender was sent from, newest first.
 *
 * The same sender is the same agent session on the same computer: never another agent's file, nor the person's
 * upload, nor a session's on another computer. An agent in a linked worktree never falls back to another checkout's
 * folder (the rule of `inboxMessagePlaces`: the main checkout's copy is not the agent's file).
 *
 * The thread's project folder is already one of the message's own places. Nothing here widens what is read: an
 * attachment is the thread's own kept copy, and a path of step 3 (or an attachment's own path, for Open in) is a
 * candidate that goes through the same readable-file checks and reach as any other.
 */
import { join, posix } from "node:path";
import { isLinkedWorktree } from "@plannotator/shared/linked-worktree";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { checkoutOf } from "./inbox-open-in";

type ThreadMessage = NonNullable<ReturnType<InboxStore["thread"]>>["messages"][number];

/** One place to try, in order: an attachment (its id, and the path it was attached from) or a path on this computer. */
export type LinkFallback = { attachment: string; path: string } | { attachment?: undefined; path: string };

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

type AgentFields = { session?: string | null; host?: string | null; name?: string | null; machine?: string | null };

/** The same agent: on the same computer (`machine`, absent for this one's), then by session, else by host and name. */
function sameSender(a: ThreadMessage["author"], b: ThreadMessage["author"]): boolean {
  if (a.kind !== "agent" || b.kind !== "agent") return false;
  const first = a as AgentFields;
  const second = b as AgentFields;
  if ((first.machine ?? null) !== (second.machine ?? null)) return false;
  if (first.session && second.session) return first.session === second.session;
  return (first.host ?? null) === (second.host ?? null) && (first.name ?? null) === (second.name ?? null);
}

/**
 * Where a relative link may be when the message's own places miss, in the order above. `home` is the home folder's
 * realpath (a checkout at home is no checkout). [] for an absolute or `~` link, a message out of that thread, or one
 * that is not an agent's.
 */
export function linkFallbacks(store: InboxStore, home: string, scope: { thread?: unknown; message?: unknown }, named: string): LinkFallback[] {
  const clean = relativeLinkPath(named);
  if (!clean) return [];
  const [own, ...earlier] = upTo(store, scope.thread, scope.message);
  if (!own || own.author.kind !== "agent") return [];
  const tail = tailOf(clean);
  const mine = earlier.filter((message) => sameSender(message.author, own.author));
  const out: LinkFallback[] = [];
  for (const message of [own, ...mine]) {
    const hit = (message.attachments ?? []).find((attachment) => attachmentMeans(attachment, tail));
    if (hit) out.push({ attachment: hit.id, path: hit.path });
  }
  const checkout = own.base_path ? checkoutOf(own.base_path, home) : null;
  const worktree = checkout && isLinkedWorktree(checkout) ? checkout : null;
  const bases = mine
    .map((message) => message.base_path ?? null)
    .filter((base): base is string => typeof base === "string" && base !== "" && base !== own.base_path)
    .filter((base) => !worktree || checkoutOf(base, home) === worktree);
  for (const base of new Set(bases)) out.push({ path: join(base, clean) });
  return out;
}

/** The attachment a link means when it is not on disk where the message says (steps 1 and 2), or null. */
export function sameNamedAttachment(fallbacks: readonly LinkFallback[]): string | null {
  return fallbacks.find((step) => step.attachment)?.attachment ?? null;
}

/** The paths of step 3 alone: the same sender's earlier folders. */
export function earlierFolderPaths(fallbacks: readonly LinkFallback[]): string[] {
  return fallbacks.filter((step) => !step.attachment).map((step) => step.path);
}
