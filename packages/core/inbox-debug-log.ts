/**
 * The Inbox's optional debug log (`<data dir>/inbox/debug.log`, JSON lines): what the server and the window both
 * saw of each request, so a stall says which step hung and whether the server got it. Off by default.
 *
 * This file is what both sides must agree on, and the one place that decides what may enter the log: routes and
 * ids only. A route keeps only the words the Inbox's own routes use and ids of the Inbox's own forms; anything else
 * becomes `*`. Query strings and bodies never enter. A window's record is rebuilt field by field from an allow list,
 * so nothing a page sends can put words in the file.
 *
 * The window imports this too, so it stays free of node imports.
 */

/** Where the window sends its buffered records. Answers only while debug is on. */
export const INBOX_DEBUG_PATH = "/api/inbox/debug/log";
/** On the Inbox's answers while debug is on, for the owner: how a window learns to record. */
export const INBOX_DEBUG_ON_HEADER = "X-Plannotator-Inbox-Debug";
/** On a window's requests while it records: the id both sides log for that request. */
export const INBOX_DEBUG_ID_HEADER = "X-Plannotator-Debug-Id";
/** The largest body the window's route reads. */
export const INBOX_DEBUG_BODY_BYTES = 256 * 1024;

/** On with `PLANNOTATOR_INBOX_DEBUG=1`, or the config-only `inboxDebug: true`. Read at start. */
export function resolveInboxDebug(config: { inboxDebug?: unknown }, env: Record<string, string | undefined>): boolean {
  return env.PLANNOTATOR_INBOX_DEBUG === "1" || config.inboxDebug === true;
}

const ROUTE_WORDS = new Set(
  (
    "api inbox ack actions agents annotations apps archived assets attachments board bridge cards check checks combine " +
    "connect content control debug decisions delete device devices dialog dismiss download draft drafts dropped embeds " +
    "event events feedback fixture.json guide handoff health image intro key lan link linked-page list-intro log m " +
    "machines mark-unread markdown-image marks markups message messages name none notes offer open-in outbox page " +
    "pairing picks pin pins poll projects reask read recent ref refs remove reply resolve restart reviewed revoke search " +
    "seen send-now sessions settings skills snooze sound status stop tailnet taggable threads tidy to tour transcribe " +
    "undo unlink unread update uploads video view voice whats-new window worklet.js"
  ).split(" "),
);
const ID_SEGMENT = /^(?:(?:msg|drf|upl|prj|dev|tdy|ibx|crd|att|ses)_[A-Za-z0-9_-]{6,}|a-[0-9a-f]{8}(?:-\d{1,3})?)$/;

/** A path as the log may hold it: no query, and `*` for any segment that is neither a route word nor an id. */
export function debugRoute(path: string): string {
  const pathname = path.split(/[?#]/, 1)[0] ?? "";
  return pathname
    .split("/")
    .map((segment) => (segment === "" || ROUTE_WORDS.has(segment) || ID_SEGMENT.test(segment) ? segment : "*"))
    .join("/");
}

/** Ids a window gives its requests and pages. */
const RECORD_ID = /^[a-z0-9-]{1,40}$/;

export function isDebugId(value: unknown): value is string {
  return typeof value === "string" && RECORD_ID.test(value);
}

const WINDOW_EVENTS = new Set([
  "page_load",
  "page_show",
  "page_hide",
  "visibility",
  "online",
  "offline",
  "send_press",
  "send_clear",
  "req_start",
  "req_head",
  "req_end",
  "req_abort",
  "req_fail",
  "buffer_dropped",
]);
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined);
const matching = (value: unknown, pattern: RegExp): string | undefined => (typeof value === "string" && pattern.test(value) ? value : undefined);

/** A window's record, rebuilt from the fields the log allows; null when it is not a record. */
export function cleanWindowRecord(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const t = count(record.t);
  if (t === undefined || typeof record.ev !== "string" || !WINDOW_EVENTS.has(record.ev)) return null;
  const fields: Record<string, unknown> = {
    t,
    side: "window",
    ev: record.ev,
    page: isDebugId(record.page) ? record.page : undefined,
    seq: count(record.seq),
    id: isDebugId(record.id) ? record.id : undefined,
    method: typeof record.method === "string" && METHODS.has(record.method) ? record.method : undefined,
    route: typeof record.route === "string" && record.route.startsWith("/api/inbox/") ? debugRoute(record.route) : undefined,
    status: count(record.status),
    ms: count(record.ms),
    error: matching(record.error, /^[A-Za-z]{1,32}$/),
    thread: typeof record.thread === "string" && ID_SEGMENT.test(record.thread) ? record.thread : undefined,
    protocol: matching(record.protocol, /^[a-z0-9./-]{1,16}$/),
    state: record.state === "visible" || record.state === "hidden" ? record.state : undefined,
    online: typeof record.online === "boolean" ? record.online : undefined,
    persisted: typeof record.persisted === "boolean" ? record.persisted : undefined,
    open: count(record.open),
    n: count(record.n),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}
