/**
 * The Inbox's optional debug log, the server's side (packages/shared/inbox/debug-log.ts says what may enter it).
 * Each API request writes a start before any work, so a request that never finishes still shows it arrived, and
 * an end. The window's buffered records come in through `accept`. Nothing here may break the Inbox: a failed write
 * is dropped. The file is capped and rotated once, to `debug.log.1`.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanWindowRecord, debugMethod, debugRoute, INBOX_DEBUG_BATCH_RECORDS, INBOX_DEBUG_BODY_BYTES, INBOX_DEBUG_ID_HEADER, INBOX_DEBUG_ON_HEADER, INBOX_DEBUG_PATH, isDebugRequestId } from "@plannotator/shared/inbox/debug-log";

/** Each of the two files. */
export const INBOX_DEBUG_MAX_BYTES = 5 * 1024 * 1024;

export interface InboxDebugLog {
  path: string;
  /**
   * `handle`, logging each `/api/inbox/` request. `owner` answers whether this request may be told debug is on and
   * may name its own id; a request from anyone else gets a server id and no mark.
   */
  wrap<Via extends string>(handle: (req: Request, via: Via) => Promise<Response>, owner: (req: Request, via: Via) => boolean): (req: Request, via: Via) => Promise<Response>;
  /** The window's records: a same-origin, owner-only POST, checked by the caller. */
  accept(req: Request): Promise<Response>;
}

/** The body as text, read no further than `cap`; null past it. Counted as it comes: a chunked body has no Content-Length. */
async function readCapped(req: Request, cap: number): Promise<string | null> {
  if (!req.body) return "";
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of req.body) {
    bytes += chunk.byteLength;
    // Leaving the loop cancels the rest of the stream.
    if (bytes > cap) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createInboxDebugLog(inboxDir: string, maxBytes = INBOX_DEBUG_MAX_BYTES): InboxDebugLog {
  const path = join(inboxDir, "debug.log");
  let size = 0;
  try {
    mkdirSync(inboxDir, { recursive: true });
    size = statSync(path).size;
  } catch {
    // No file yet.
  }

  /** Whole lines, in one write: a window's batch does not stop the event loop once per record. */
  const append = (text: string): void => {
    try {
      const bytes = Buffer.byteLength(text);
      if (size > 0 && size + bytes > maxBytes) {
        renameSync(path, `${path}.1`);
        size = 0;
      }
      appendFileSync(path, text, { mode: 0o600 });
      size += bytes;
    } catch {
      // The log never gets in the Inbox's way.
    }
  };
  const line = (record: Record<string, unknown>): string => `${JSON.stringify(record)}\n`;

  let serial = 0;
  return {
    path,
    wrap(handle, owner) {
      const isOwner: typeof owner = (req, via) => {
        try {
          return owner(req, via);
        } catch {
          return false;
        }
      };
      return async (req, via) => {
        let pathname: string;
        try {
          pathname = new URL(req.url, "http://127.0.0.1").pathname;
        } catch {
          return handle(req, via);
        }
        if (!pathname.startsWith("/api/inbox/") || pathname === INBOX_DEBUG_PATH) return handle(req, via);
        const ours = isOwner(req, via);
        const given = ours ? req.headers.get(INBOX_DEBUG_ID_HEADER) : null;
        serial += 1;
        const id = isDebugRequestId(given) ? given : `s${serial}`;
        const started = Date.now();
        const base = { side: "server", id, method: debugMethod(req.method), route: debugRoute(pathname), via };
        append(line({ t: started, ev: "req_start", ...base }));
        let response: Response;
        try {
          response = await handle(req, via);
        } catch (cause) {
          append(line({ t: Date.now(), ev: "req_error", ...base, ms: Date.now() - started }));
          throw cause;
        }
        append(line({ t: Date.now(), ev: "req_end", ...base, status: response.status, ms: Date.now() - started }));
        try {
          if (ours) response.headers.set(INBOX_DEBUG_ON_HEADER, "1");
        } catch {
          // Headers that cannot change: the answer matters more than the mark.
        }
        return response;
      };
    },
    async accept(req) {
      const tooLarge = () => Response.json({ error: "Too many records at once.", code: "debug_log_too_large" }, { status: 413 });
      const text = await readCapped(req, INBOX_DEBUG_BODY_BYTES);
      if (text === null) return tooLarge();
      let records: unknown;
      try {
        records = (JSON.parse(text) as { records?: unknown }).records;
      } catch {
        records = null;
      }
      if (!Array.isArray(records)) return Response.json({ error: "records: expected a list.", code: "validation_error" }, { status: 400 });
      if (records.length > INBOX_DEBUG_BATCH_RECORDS) return tooLarge();
      const at = Date.now();
      const kept: string[] = [];
      for (const raw of records) {
        const record = cleanWindowRecord(raw);
        if (record) kept.push(line({ ...record, at }));
      }
      if (kept.length > 0) append(kept.join(""));
      return Response.json({ ok: true, written: kept.length });
    },
  };
}
