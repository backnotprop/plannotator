/**
 * The Inbox's optional debug log (`<data dir>/inbox/debug.log`, JSON lines): what the server and the window both
 * saw of each request, so a stall says which step hung and whether the server got it. Off by default.
 *
 * This file is what both sides must agree on, and the one place that decides what may enter the log. The owner may
 * paste the file publicly, so every value is one of these: a number, a word from a fixed list here, an id in the exact
 * shape the Inbox makes (a ULID with its prefix), or a window id made of digits. A path segment that is none of those
 * becomes `*`. Query strings and bodies never enter. A window's record is rebuilt field by field, so a value that
 * fails its check is dropped, whoever sent it.
 *
 * The one thing a shape cannot rule out: a crafted 26-character string in the ULID alphabet passes as an id. The Inbox
 * makes no such string from a person's words.
 *
 * The window imports this by relative path, so it stays free of imports. It is private: `@plannotator/core` is
 * published, and a new core export would need a release of core before the UI's.
 */

/** Where the window sends its buffered records. Answers only while debug is on. */
export const INBOX_DEBUG_PATH = "/api/inbox/debug/log";
/** On the Inbox's answers while debug is on, for the owner: how a window learns to record. */
export const INBOX_DEBUG_ON_HEADER = "X-Plannotator-Inbox-Debug";
/** On a window's requests while it records: the id both sides log for that request. */
export const INBOX_DEBUG_ID_HEADER = "X-Plannotator-Debug-Id";
/** The largest body the window's route reads. */
export const INBOX_DEBUG_BODY_BYTES = 256 * 1024;
/** The most records in one body: the window's batch, and past it a refusal, so one request cannot hold up the Inbox. */
export const INBOX_DEBUG_BATCH_RECORDS = 500;

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
const ULID = "[0-9A-HJKMNP-TV-Z]{26}";
const ID_SEGMENT = new RegExp(`^(?:(?:msg|prj|ses|dec|dev|upl|drf|crd|tdy|ibx|att)_${ULID}|a-[0-9a-f]{8}(?:-\\d{1,3})?)$`);
const THREAD_ID = new RegExp(`^msg_${ULID}$`);

/** A path as the log may hold it: no query, and `*` for any segment that is neither a route word nor an id. */
export function debugRoute(path: string): string {
  const pathname = path.split(/[?#]/, 1)[0] ?? "";
  return pathname
    .split("/")
    .map((segment) => (segment === "" || ROUTE_WORDS.has(segment) || ID_SEGMENT.test(segment) ? segment : "*"))
    .join("/");
}

/** A window's page id and its requests' ids: digits only, so no words fit. */
export function debugPageId(now: number): string {
  return `p${Math.floor(now)}-${Math.floor(Math.random() * 1e6)}`;
}
const PAGE_ID = /^p\d{1,16}-\d{1,6}$/;
const REQUEST_ID = /^p\d{1,16}-\d{1,6}-\d{1,9}$/;

export function isDebugRequestId(value: unknown): value is string {
  return typeof value === "string" && REQUEST_ID.test(value);
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
/** A request's method as the log may hold it: a raw client can send any token, and one off the list is `other`. */
export function debugMethod(method: string): string {
  return METHODS.has(method) ? method : "other";
}
/** The names a failed fetch or body read can carry. Another name is dropped: the line still says it failed. */
const ERRORS = new Set(["AbortError", "TimeoutError", "TypeError", "NetworkError", "SecurityError", "NotAllowedError", "NotSupportedError", "InvalidStateError", "SyntaxError", "Error"]);
/** `nextHopProtocol` as browsers report it. */
const PROTOCOLS = new Set(["http/0.9", "http/1.0", "http/1.1", "h2", "h2c", "h3"]);
const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined);
const listed = (value: unknown, list: Set<string>): string | undefined => (typeof value === "string" && list.has(value) ? value : undefined);
const shaped = (value: unknown, shape: RegExp): string | undefined => (typeof value === "string" && shape.test(value) ? value : undefined);

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
    page: shaped(record.page, PAGE_ID),
    seq: count(record.seq),
    id: shaped(record.id, REQUEST_ID),
    method: listed(record.method, METHODS),
    route: typeof record.route === "string" && record.route.startsWith("/api/inbox/") ? debugRoute(record.route) : undefined,
    status: count(record.status),
    ms: count(record.ms),
    error: listed(record.error, ERRORS),
    thread: shaped(record.thread, THREAD_ID),
    protocol: listed(record.protocol, PROTOCOLS),
    state: record.state === "visible" || record.state === "hidden" ? record.state : undefined,
    online: typeof record.online === "boolean" ? record.online : undefined,
    persisted: typeof record.persisted === "boolean" ? record.persisted : undefined,
    open: count(record.open),
    n: count(record.n),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}
