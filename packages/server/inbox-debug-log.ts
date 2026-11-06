/**
 * The Inbox's optional debug log, the server's side (packages/shared/inbox/debug-log.ts says what may enter it).
 * Each API request writes a start before any work, so a request that never finishes still shows it arrived, and
 * an end. The window's buffered records come in through `accept`. Nothing here may break the Inbox: a failed write
 * is dropped. The file is capped and rotated once, to `debug.log.1`.
 *
 * Lines are kept in memory and written in order, asynchronously, about every `INBOX_DEBUG_FLUSH_MS` (sooner past
 * `INBOX_DEBUG_FLUSH_BYTES`), so no request waits on the disk; whatever is still kept when the process exits is
 * written then. Past `INBOX_DEBUG_PENDING_MAX_BYTES` waiting (a disk that stopped answering), new lines are dropped.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { appendFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { cleanWindowRecord, debugMethod, debugRoute, INBOX_DEBUG_BATCH_RECORDS, INBOX_DEBUG_BODY_BYTES, INBOX_DEBUG_ID_HEADER, INBOX_DEBUG_ON_HEADER, INBOX_DEBUG_PATH, isDebugRequestId } from "@plannotator/shared/inbox/debug-log";

/** Each of the two files. */
export const INBOX_DEBUG_MAX_BYTES = 5 * 1024 * 1024;
/** How long a line waits in memory before it is written. */
export const INBOX_DEBUG_FLUSH_MS = 250;
/** Kept lines past this are written at once. */
export const INBOX_DEBUG_FLUSH_BYTES = 64 * 1024;
/** Lines waiting past this are dropped, as the window's own buffer drops them. */
export const INBOX_DEBUG_PENDING_MAX_BYTES = 4 * 1024 * 1024;

export interface InboxDebugLog {
  path: string;
  /**
   * `handle`, logging each `/api/inbox/` request. `owner` answers whether this request may be told debug is on and
   * may name its own id; a request from anyone else gets a server id and no mark.
   */
  wrap<Via extends string>(handle: (req: Request, via: Via) => Promise<Response>, owner: (req: Request, via: Via) => boolean): (req: Request, via: Via) => Promise<Response>;
  /** The window's records: a same-origin, owner-only POST, checked by the caller. */
  accept(req: Request): Promise<Response>;
  /** One line the server writes about something it did on its own (`ev` names it), stamped now. */
  note(ev: string, fields: Record<string, unknown>): void;
  /** Every line kept so far, written: resolves once they are on disk. */
  flush(): Promise<void>;
  /**
   * Write what is kept now (the server's stop): synchronously when no write is in flight, else right after it, so
   * the order holds. Lines that come later still go in.
   */
  close(): void;
}

/** Every log in this process with lines kept or being written, so an exit writes them, and tests can wait for the disk. */
const busyLogs = new Map<InboxDebugLog, () => void>();
let exitHooked = false;
/** The process is exiting: what each log keeps goes in now, synchronously (a write in flight may not finish). */
const onExit = (): void => {
  for (const drainNow of busyLogs.values()) drainNow();
};

/** Tests: every debug log's kept lines, on disk. */
export async function flushInboxDebugLogs(): Promise<void> {
  await Promise.all([...busyLogs.keys()].map((log) => log.flush()));
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

  /**
   * Whole lines, kept in order; each `append` stays one piece, so rotation never splits a window's batch across
   * the two files. Written by `drain`, one write per file.
   */
  let pending: { text: string; bytes: number }[] = [];
  let pendingBytes = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The writes in flight, one after another: lines reach the file in the order they were kept. */
  let chain: Promise<void> = Promise.resolve();
  let inFlight = 0;
  /** Off the busy list once nothing is kept and nothing is being written. */
  const settle = () => {
    if (pending.length === 0 && inFlight === 0) busyLogs.delete(log);
  };

  /** The kept pieces as writes: each file's run of pieces in one write, a rotation between where the cap falls. */
  const plan = (pieces: { text: string; bytes: number }[]): { rotate: boolean; text: string }[] => {
    const steps: { rotate: boolean; text: string }[] = [];
    let run: string[] = [];
    let rotate = false;
    for (const piece of pieces) {
      if (size > 0 && size + piece.bytes > maxBytes) {
        if (run.length > 0 || rotate) steps.push({ rotate, text: run.join("") });
        run = [];
        rotate = true;
        size = 0;
      }
      run.push(piece.text);
      size += piece.bytes;
    }
    if (run.length > 0 || rotate) steps.push({ rotate, text: run.join("") });
    return steps;
  };

  const take = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const pieces = pending;
    pending = [];
    pendingBytes = 0;
    return pieces;
  };

  const drain = (): Promise<void> => {
    const pieces = take();
    if (pieces.length === 0) return chain;
    const steps = plan(pieces);
    inFlight += 1;
    chain = chain.then(async () => {
      for (const step of steps) {
        try {
          if (step.rotate) await rename(path, `${path}.1`);
          if (step.text) await appendFile(path, step.text, { mode: 0o600 });
        } catch {
          // The log never gets in the Inbox's way.
        }
      }
      inFlight -= 1;
      settle();
    });
    return chain;
  };

  const append = (text: string): void => {
    const bytes = Buffer.byteLength(text);
    if (pendingBytes + bytes > INBOX_DEBUG_PENDING_MAX_BYTES) return;
    pending.push({ text, bytes });
    pendingBytes += bytes;
    busyLogs.set(log, drainNow);
    if (!exitHooked) {
      exitHooked = true;
      process.on("exit", onExit);
    }
    if (pendingBytes >= INBOX_DEBUG_FLUSH_BYTES) {
      void drain();
      return;
    }
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        void drain();
      }, INBOX_DEBUG_FLUSH_MS);
      (timer as { unref?: () => void }).unref?.();
    }
  };

  /** What is kept, written now and synchronously (the process is exiting, or the server stopping). */
  const drainNow = (): void => {
    for (const step of plan(take())) {
      try {
        if (step.rotate) renameSync(path, `${path}.1`);
        if (step.text) appendFileSync(path, step.text, { mode: 0o600 });
      } catch {
        // The log never gets in the Inbox's way.
      }
    }
    settle();
  };
  const line = (record: Record<string, unknown>): string => `${JSON.stringify(record)}\n`;

  let serial = 0;
  const log: InboxDebugLog = {
    path,
    flush: drain,
    close() {
      if (inFlight > 0) void drain();
      else drainNow();
    },
    note(ev, fields) {
      append(line({ t: Date.now(), ev, side: "server", ...fields }));
    },
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
  return log;
}
