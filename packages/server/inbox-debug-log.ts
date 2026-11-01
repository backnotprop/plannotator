/**
 * The Inbox's optional debug log, the server's side (packages/core/inbox-debug-log.ts says what may enter it).
 * Each API request writes a start before any work, so a request that never finishes still shows it arrived, and
 * an end. The window's buffered records come in through `accept`. Nothing here may break the Inbox: a failed write
 * is dropped. The file is capped and rotated once, to `debug.log.1`.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { cleanWindowRecord, debugRoute, INBOX_DEBUG_BODY_BYTES, INBOX_DEBUG_ID_HEADER, INBOX_DEBUG_ON_HEADER, INBOX_DEBUG_PATH, isDebugId } from "@plannotator/core/inbox-debug-log";

/** Each of the two files. */
export const INBOX_DEBUG_MAX_BYTES = 5 * 1024 * 1024;

export interface InboxDebugLog {
  path: string;
  /** `handle`, logging each `/api/inbox/` request. `owner` answers whether this request may be told debug is on. */
  wrap<Via extends string>(handle: (req: Request, via: Via) => Promise<Response>, owner: (req: Request, via: Via) => boolean): (req: Request, via: Via) => Promise<Response>;
  /** The window's records: a same-origin, owner-only POST, checked by the caller. */
  accept(req: Request): Promise<Response>;
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

  const write = (record: Record<string, unknown>): void => {
    try {
      const line = `${JSON.stringify(record)}\n`;
      const bytes = Buffer.byteLength(line);
      if (size > 0 && size + bytes > maxBytes) {
        renameSync(path, `${path}.1`);
        size = 0;
      }
      appendFileSync(path, line, { mode: 0o600 });
      size += bytes;
    } catch {
      // The log never gets in the Inbox's way.
    }
  };

  let serial = 0;
  return {
    path,
    wrap(handle, owner) {
      return async (req, via) => {
        let pathname: string;
        try {
          pathname = new URL(req.url, "http://127.0.0.1").pathname;
        } catch {
          return handle(req, via);
        }
        if (!pathname.startsWith("/api/inbox/") || pathname === INBOX_DEBUG_PATH) return handle(req, via);
        const given = req.headers.get(INBOX_DEBUG_ID_HEADER);
        serial += 1;
        const id = isDebugId(given) ? given : `s${serial}`;
        const started = Date.now();
        const base = { side: "server", id, method: req.method, route: debugRoute(pathname), via };
        write({ t: started, ev: "req_start", ...base });
        try {
          const response = await handle(req, via);
          write({ t: Date.now(), ev: "req_end", ...base, status: response.status, ms: Date.now() - started });
          if (owner(req, via)) response.headers.set(INBOX_DEBUG_ON_HEADER, "1");
          return response;
        } catch (cause) {
          write({ t: Date.now(), ev: "req_error", ...base, ms: Date.now() - started });
          throw cause;
        }
      };
    },
    async accept(req) {
      const tooLarge = () => Response.json({ error: "Too many records at once.", code: "debug_log_too_large" }, { status: 413 });
      if (Number(req.headers.get("content-length") ?? 0) > INBOX_DEBUG_BODY_BYTES) return tooLarge();
      const text = await req.text();
      if (Buffer.byteLength(text) > INBOX_DEBUG_BODY_BYTES) return tooLarge();
      let records: unknown;
      try {
        records = (JSON.parse(text) as { records?: unknown }).records;
      } catch {
        records = null;
      }
      if (!Array.isArray(records)) return Response.json({ error: "records: expected a list.", code: "validation_error" }, { status: 400 });
      const at = Date.now();
      let written = 0;
      for (const raw of records) {
        const record = cleanWindowRecord(raw);
        if (!record) continue;
        write({ ...record, at });
        written += 1;
      }
      return Response.json({ ok: true, written });
    },
  };
}
