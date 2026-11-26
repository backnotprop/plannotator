/**
 * Plannotator Inbox: pinned artifacts and the Artifacts wall (approval
 * "inbox-artifact-stars", .product/approved/inbox-artifact-stars/; the word
 * is Pin). The window's routes (the page's `serverSession` on a write; reads
 * refuse another site, as the attachment routes do). Bun only: the Inbox
 * runs on the Bun server; the Pi server serves no Inbox route.
 *
 *   GET  /api/inbox/artifact-pins   `{ pins: [{ key, thread_id, pinned_at }] }`, in pin order
 *   POST /api/inbox/artifact-pins   `{ thread_id, key, pinned: boolean }`: pin or unpin one artifact; `{ pins }`
 *   GET  /api/inbox/artifacts       the Wall: every thread's artifacts, newest first, paged, with filters
 *
 * `?machines=1` on either GET: across linked machines too (inbox-artifacts-merged.ts). A linked machine's window
 * pins this Inbox's artifacts through its door (`POST artifact-pins`) and reads its Wall (`GET artifacts`).
 *
 * Not the sidebar's thread pins (inbox-pins.ts): another file, other routes.
 * A change tells every window (`event: artifact-pins` on the window's stream).
 * Agents, the MCP, search and the phone's door never see artifact pins.
 */

import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import {
  INBOX_ARTIFACT_TYPES,
  INBOX_ARTIFACTS_PAGE,
  INBOX_ARTIFACTS_PAGE_MAX,
  inboxArtifactTypeOf,
  type InboxArtifactPin,
  type InboxArtifactRef,
  type InboxArtifactRow,
  type InboxArtifactsPage,
  type InboxArtifactType,
} from "@plannotator/core/inbox-artifact-pins";
import { displayInboxSubject, inboxRowArchived, type InboxListRow, type InboxMessage } from "@plannotator/core/inbox-types";
import { inboxAttachmentState } from "@plannotator/shared/inbox/attachments";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { artifactPinsWire, farWallSearch, mergeArtifactPins, mergeWall, readWallCursor, type FarWall } from "./inbox-artifacts-merged";
import { INBOX_CROSS_SITE_BODY, isCrossSiteRequest } from "./inbox-cross-site";

export const INBOX_ARTIFACT_PINS_PATH = "/api/inbox/artifact-pins";
export const INBOX_ARTIFACTS_PATH = "/api/inbox/artifacts";

interface WallEntry {
  ref: InboxArtifactRef<InboxMessage>;
  row: InboxListRow;
  type: InboxArtifactType;
  archived: boolean;
  pinnedAt: string | null;
}

/** `?name=` one of `values`, or null when absent; anything else is refused. */
function oneOf<T extends string>(url: URL, name: string, values: readonly T[]): T | null {
  const value = url.searchParams.get(name);
  if (value === null || value === "") return null;
  if (!(values as readonly string[]).includes(value)) throw new InboxError("validation_error", `${name}: one of ${values.join(", ")}.`, { field: name });
  return value as T;
}

function whole(url: URL, name: string, min: number, max: number): number | null {
  const value = url.searchParams.get(name);
  if (value === null || value === "") return null;
  const n = /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new InboxError("validation_error", `${name}: a whole number from ${min} to ${max}.`, { field: name });
  return n;
}

/**
 * Every artifact of every thread the list shows, newest message first; inside
 * a message, its own order (the thread grid's order, artifacts.ts
 * `artifactsNewestFirst`). Archived threads only with `archived`.
 */
export function inboxWallEntries(store: InboxStore, includeArchived: boolean): WallEntry[] {
  const pinned = new Map(store.artifactPins().map((pin) => [pin.key, pin.pinned_at]));
  const out: { entry: WallEntry; at: string; order: number }[] = [];
  let order = 0;
  for (const threadId of store.threadIds()) {
    const row = store.listRow(threadId);
    if (!row) continue;
    const archived = inboxRowArchived(row);
    if (archived && !includeArchived) continue;
    for (const ref of store.threadArtifactRefs(threadId)) {
      const type = inboxArtifactTypeOf(ref.attachment ? ref.attachment.kind : ref.html ? "html" : "guide");
      out.push({ entry: { ref, row, type, archived, pinnedAt: pinned.get(ref.key) ?? null }, at: ref.message.created_at, order: order++ });
    }
  }
  // Newest message first; the same moment keeps reading order.
  out.sort((a, b) => (a.at === b.at ? a.order - b.order : a.at < b.at ? 1 : -1));
  return out.map((x) => x.entry);
}

/** The Wall's page for a request's filters (`pinned=1`, `type=`, `archived=include|exclude`, `cursor=`, `limit=`). */
export async function inboxArtifactsPage(store: InboxStore, url: URL): Promise<InboxArtifactsPage> {
  const pinnedOnly = (() => {
    const value = url.searchParams.get("pinned");
    if (value === null || value === "" || value === "0") return false;
    if (value === "1") return true;
    throw new InboxError("validation_error", "pinned: 1 or 0.", { field: "pinned" });
  })();
  const type = oneOf(url, "type", INBOX_ARTIFACT_TYPES);
  const archived = oneOf(url, "archived", ["include", "exclude"] as const) ?? "exclude";
  const cursor = whole(url, "cursor", 0, Number.MAX_SAFE_INTEGER) ?? 0;
  const limit = whole(url, "limit", 1, INBOX_ARTIFACTS_PAGE_MAX) ?? INBOX_ARTIFACTS_PAGE;
  const entries = inboxWallEntries(store, archived === "include");
  const types = Object.fromEntries(INBOX_ARTIFACT_TYPES.map((t) => [t, 0])) as Record<InboxArtifactType, number>;
  let all = 0;
  let pinned = 0;
  const shown: WallEntry[] = [];
  for (const entry of entries) {
    if (!pinnedOnly || entry.pinnedAt !== null) types[entry.type] += 1;
    if (type !== null && entry.type !== type) continue;
    all += 1;
    if (entry.pinnedAt !== null) pinned += 1;
    if (!pinnedOnly || entry.pinnedAt !== null) shown.push(entry);
  }
  const page = shown.slice(cursor, cursor + limit);
  const artifacts = await Promise.all(page.map((entry) => wallRow(entry)));
  return {
    artifacts,
    next_cursor: cursor + limit < shown.length ? String(cursor + limit) : null,
    total: shown.length,
    counts: { all, pinned, types },
  };
}

async function wallRow({ ref, row, type, archived, pinnedAt }: WallEntry): Promise<InboxArtifactRow> {
  return {
    key: ref.key,
    thread_id: row.thread_id,
    thread_title: displayInboxSubject(row.subject) ?? row.thread_name ?? "Untitled thread",
    project: { id: row.project.id, name: row.project.name },
    message_id: ref.message.id,
    at: ref.message.created_at,
    author: ref.message.author,
    type,
    // A changed large file is judged by its stat here, as the thread's attachments are.
    attachment: ref.attachment ? await inboxAttachmentState(ref.attachment, ref.message.id, { hash: "small" }) : null,
    inline: ref.inline,
    guide: ref.guide,
    // An html block: its heading and size only (the tile is a quiet card; the block opens in its thread).
    ...(ref.html ? { html: { title: ref.html.title, size: ref.html.size } } : {}),
    archived,
    pinned_at: pinnedAt,
  };
}

/** What the merged reads (`?machines=1`) need of the linked machines (inbox-machines.ts; inbox-artifacts-merged.ts). */
export interface ArtifactPinMachines {
  /** Each linked machine's pins as its list last said, from a machine that takes the mark. */
  pinLists: () => { machine: string; pins: readonly InboxArtifactPin[] }[];
  /** Each linked machine's Wall page that takes the mark, asked with its own search. */
  walls: (searchOf: (machine: string) => string) => Promise<FarWall[]>;
}

/** The Wall across linked machines: this Inbox's page from its own offset, and each machine's from its own. */
async function mergedArtifactsPage(store: InboxStore, url: URL, machines: ArtifactPinMachines): Promise<InboxArtifactsPage> {
  const cursor = readWallCursor(url.searchParams.get("cursor"));
  if (!cursor) throw new InboxError("validation_error", "cursor: the next_cursor of the page before.", { field: "cursor" });
  const limit = whole(url, "limit", 1, INBOX_ARTIFACTS_PAGE_MAX) ?? INBOX_ARTIFACTS_PAGE;
  const ownUrl = new URL(url);
  ownUrl.searchParams.set("cursor", String(cursor.own));
  const own = await inboxArtifactsPage(store, ownUrl);
  const far = await machines.walls((machine) => farWallSearch(url, cursor.far.get(machine) ?? 0, limit));
  return mergeWall(own, far, cursor, limit, (threadId) => store.message(threadId) !== null);
}

export function createInboxArtifactPins(options: {
  store: InboxStore;
  serverSession: string;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
  machines?: ArtifactPinMachines;
}) {
  const { store, serverSession, json, machines } = options;
  const wire = artifactPinsWire;
  const merged = (url: URL) => machines !== undefined && url.searchParams.get("machines") === "1";

  const route = async (req: Request, url: URL): Promise<Response | null> => {
    if (url.pathname === INBOX_ARTIFACTS_PATH) {
      if (req.method !== "GET") return json({ error: "Use GET." }, 405);
      if (isCrossSiteRequest(req)) return json(INBOX_CROSS_SITE_BODY, 403);
      return json({ serverSession, ...(merged(url) ? await mergedArtifactsPage(store, url, machines!) : await inboxArtifactsPage(store, url)) });
    }
    if (url.pathname !== INBOX_ARTIFACT_PINS_PATH) return null;
    if (req.method === "GET") {
      if (isCrossSiteRequest(req)) return json(INBOX_CROSS_SITE_BODY, 403);
      if (merged(url)) return json({ pins: mergeArtifactPins(store.artifactPins(), machines!.pinLists(), (threadId) => store.message(threadId) !== null) });
      return json({ pins: wire(store.artifactPins()) });
    }
    if (req.method !== "POST") return json({ error: "Use GET or POST." }, 405);
    const body = await options.readBody(req);
    if (checkServerSession(body, serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    if (typeof body.pinned !== "boolean") throw new InboxError("validation_error", "pinned: a boolean.", { field: "pinned" });
    if (typeof body.thread_id !== "string") throw new InboxError("validation_error", "thread_id: the thread's id (msg_).", { field: "thread_id" });
    return json({ pins: wire(store.setArtifactPinned(body.thread_id, body.key, body.pinned)) });
  };

  return { route };
}
