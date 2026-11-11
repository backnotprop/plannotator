/**
 * The Inbox's optional debug log, the server's side (packages/shared/inbox/debug-log.ts says what may enter it).
 * Each API request writes a start before any work, and an end: a request that never finishes still shows it
 * arrived, once its start is on disk (within about `INBOX_DEBUG_FLUSH_MS`; a loop blocked by it keeps the start in
 * memory, written at the exit, so only a force-kill of a blocked process loses it). The window's buffered records
 * come in through `accept`. Nothing here may break the Inbox: a failed write is dropped. The file is capped and
 * rotated once, to `debug.log.1`.
 *
 * Lines are kept in memory and written in order, asynchronously, about every `INBOX_DEBUG_FLUSH_MS` (sooner past
 * `INBOX_DEBUG_FLUSH_BYTES`), so no request waits on the disk; whatever is still kept when the process exits is
 * written then, as the server's stop writes it (the write in flight too, again at its own place: never twice). Past
 * `INBOX_DEBUG_PENDING_MAX_BYTES` not yet on disk (a disk that stopped answering), new lines are dropped.
 */
import { closeSync, constants, fstat, fstatSync, mkdirSync, open, openSync, renameSync, stat, statSync, write, writeSync } from "node:fs";
import { promisify } from "node:util";
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
  /** `handle`, logging each `/api/inbox/` request; the window's request may name its own id. */
  wrap<Via extends string>(handle: (req: Request, via: Via) => Promise<Response>): (req: Request, via: Via) => Promise<Response>;
  /** The window's records: a same-origin, owner-only POST, checked by the caller. */
  accept(req: Request): Promise<Response>;
  /** One line the server writes about something it did on its own (`ev` names it), stamped now. */
  note(ev: string, fields: Record<string, unknown>): void;
  /** Every line kept so far, written: resolves once they are on disk. */
  flush(): Promise<void>;
  /**
   * Write everything not yet on disk now, synchronously and in order (the server's stop), the write in flight
   * included. Lines that come later still go in.
   */
  close(): void;
}

const statAsync = promisify(stat);
const fstatAsync = promisify(fstat);
const openAsync = promisify(open);
const writeAsync = (fd: number, buf: Buffer, offset: number, length: number, position: number) =>
  new Promise<{ bytesWritten: number }>((resolve, reject) => write(fd, buf, offset, length, position, (error, bytesWritten) => (error ? reject(error) : resolve({ bytesWritten }))));

/**
 * One planned write: `rotate` first moves the full file aside. Once started it has its file and offset (`fd`, `at`),
 * so writing it twice (the write in flight, and a stop's) puts the same bytes in the same place.
 */
interface Step {
  rotate: boolean;
  rotated: boolean;
  buf: Buffer;
  /** The pieces' bytes as kept (`outstanding` counts these). */
  bytes: number;
  fd: number | null;
  at: number;
  done: boolean;
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
   * Whole lines not yet planned, in order; each `append` stays one piece, so rotation never splits a window's batch
   * across the two files.
   */
  let pending: { text: string; bytes: number }[] = [];
  let pendingBytes = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Planned writes not yet started, in order (`plan`). Data, so a stop or an exit can write them itself. */
  let queue: Step[] = [];
  /** The one write started and not yet finished: its file and offset are fixed (`Step.fd`, `Step.at`). */
  let writing: Step | null = null;
  /** Bytes kept and not yet on disk (pending, queued, being written): the cap counts them all. */
  let outstanding = 0;
  /** The open file and where its next byte goes; reopened when the file was moved or removed. */
  let fd: number | null = null;
  let ino = -1;
  let end = 0;
  /** Files given up while a write on them may still be running: closed once it ends. */
  const retired: number[] = [];
  const waiters: (() => void)[] = [];

  const closeQuietly = (n: number): void => {
    try {
      closeSync(n);
    } catch {
      // Already closed.
    }
  };
  /** Stop using the open file; closed now, or once the write on it ends (its number must not be reused under it). */
  const retire = (): void => {
    if (fd === null) return;
    if (writing && writing.fd === fd) retired.push(fd);
    else closeQuietly(fd);
    fd = null;
  };
  /** The file to write, opened (synchronously) if it is not, or not the one at `path` any more. */
  const openNow = (): number => {
    if (fd !== null) {
      let same = false;
      try {
        same = statSync(path).ino === ino;
      } catch {
        // Gone: open it again.
      }
      if (same) return fd;
      retire();
    }
    const n = openSync(path, constants.O_WRONLY | constants.O_CREAT, 0o600);
    const stat = fstatSync(n);
    fd = n;
    ino = stat.ino;
    end = stat.size;
    return n;
  };
  /** Rotation at the step's start: the full file becomes `debug.log.1`. Rare (once a file), so done at once. */
  const rotateNow = (step: Step): void => {
    if (!step.rotate || step.rotated) return;
    step.rotated = true;
    retire();
    try {
      renameSync(path, `${path}.1`);
    } catch {
      // The log never gets in the Inbox's way.
    }
  };
  /** The step's place in the file, fixed: whoever writes it (this write or a stop's) writes the same bytes there. */
  const place = (step: Step, n: number): void => {
    step.fd = n;
    step.at = end;
    end += step.buf.byteLength;
  };
  const finished = (step: Step): void => {
    if (step.done) return;
    step.done = true;
    outstanding -= step.bytes;
  };
  /** Nothing kept or queued: off the busy list, and anyone waiting on the disk is told. */
  const settle = (): void => {
    if (queue.length > 0 || (writing && !writing.done)) return;
    for (const waiter of waiters.splice(0)) waiter();
    if (pending.length === 0) busyLogs.delete(log);
  };

  /** The kept pieces as writes: each file's run of pieces in one write, a rotation between where the cap falls. */
  const plan = (pieces: { text: string; bytes: number }[]): Step[] => {
    const steps: Step[] = [];
    let run: string[] = [];
    let runBytes = 0;
    let rotate = false;
    const push = () => {
      if (run.length > 0 || rotate) steps.push({ rotate, rotated: false, buf: Buffer.from(run.join("")), bytes: runBytes, fd: null, at: 0, done: false });
    };
    for (const piece of pieces) {
      if (size > 0 && size + piece.bytes > maxBytes) {
        push();
        run = [];
        runBytes = 0;
        rotate = true;
        size = 0;
      }
      run.push(piece.text);
      runBytes += piece.bytes;
      size += piece.bytes;
    }
    push();
    return steps;
  };

  /** What is kept, planned onto the queue. */
  const enqueue = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.length === 0) return;
    const pieces = pending;
    pending = [];
    pendingBytes = 0;
    queue.push(...plan(pieces));
  };

  /** One write off the loop: rotation and the file's place now, then the bytes; a stop may write them first. */
  const run = async (step: Step): Promise<void> => {
    rotateNow(step);
    if (step.buf.byteLength === 0) return finished(step);
    if (fd !== null) {
      const now = await statAsync(path).catch(() => null);
      if (step.done) return;
      if (!now || now.ino !== ino) retire();
    }
    if (fd === null) {
      const n = await openAsync(path, constants.O_WRONLY | constants.O_CREAT, 0o600);
      const stat = await fstatAsync(n).catch(() => null);
      // A stop wrote this step meanwhile, through its own file: this one is not needed.
      if (step.done || fd !== null || !stat) return closeQuietly(n);
      fd = n;
      ino = stat.ino;
      end = stat.size;
    }
    place(step, fd);
    let off = 0;
    while (off < step.buf.byteLength) {
      const { bytesWritten } = await writeAsync(step.fd!, step.buf, off, step.buf.byteLength - off, step.at + off);
      if (bytesWritten <= 0) break;
      off += bytesWritten;
    }
    finished(step);
  };

  /** The queue, one write at a time, in order. */
  const pump = (): void => {
    if (writing || queue.length === 0) return settle();
    const step = queue.shift()!;
    writing = step;
    void run(step)
      .catch(() => finished(step))
      .finally(() => {
        if (writing === step) writing = null;
        for (const n of retired.splice(0)) closeQuietly(n);
        pump();
      });
  };

  const drain = (): Promise<void> => {
    enqueue();
    pump();
    if (queue.length === 0 && !(writing && !writing.done)) return Promise.resolve();
    return new Promise((resolve) => waiters.push(resolve));
  };

  const append = (text: string): void => {
    const bytes = Buffer.byteLength(text);
    if (outstanding + bytes > INBOX_DEBUG_PENDING_MAX_BYTES) return;
    pending.push({ text, bytes });
    pendingBytes += bytes;
    outstanding += bytes;
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

  /**
   * Everything not yet on disk, written now and synchronously, in order (the process is exiting, or the server
   * stopping): the write in flight again at its own place (the same bytes, so never twice), then the queue, then
   * what is kept.
   */
  const drainNow = (): void => {
    enqueue();
    const steps = writing && !writing.done ? [writing, ...queue] : queue;
    queue = [];
    for (const step of steps) {
      try {
        if (step.fd === null) {
          rotateNow(step);
          if (step.buf.byteLength > 0) place(step, openNow());
        }
        let off = 0;
        while (step.fd !== null && off < step.buf.byteLength) {
          const wrote = writeSync(step.fd, step.buf, off, step.buf.byteLength - off, step.at + off);
          if (wrote <= 0) break;
          off += wrote;
        }
      } catch {
        // The log never gets in the Inbox's way.
      }
      finished(step);
    }
    settle();
  };
  const line = (record: Record<string, unknown>): string => `${JSON.stringify(record)}\n`;

  let serial = 0;
  const log: InboxDebugLog = {
    path,
    flush: drain,
    close() {
      drainNow();
      retire();
    },
    note(ev, fields) {
      append(line({ t: Date.now(), ev, side: "server", ...fields }));
    },
    wrap(handle) {
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
          response.headers.set(INBOX_DEBUG_ON_HEADER, "1");
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
