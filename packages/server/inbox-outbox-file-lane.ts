/**
 * A held answer's files on their way to the other computer (inbox-outbox-files.ts): their own lane per linked
 * computer, outside the write queue, so the person's writes and this Inbox's wakes never wait on a file. One file at a
 * time, oldest entry first; once an entry's files are all there its answer takes its place in the write queue
 * (`outboxWaitsForFiles`), behind nothing but that agent's earlier answers in the same thread.
 *
 * A file ends only when no byte moves for OUTBOX_FILE_IDLE_MS (`uploadOutboxFile`): its pieces are pulled only as the
 * socket takes them, so a slow file that keeps moving goes. The bytes still in the sockets' buffers after the last
 * piece (a few MB at most, fewer on a slow line) and that door's answer must come within the same limit. What a
 * file's try can come to:
 * - it lands: its id saved on the entry (`sent_files`) before the next leaves;
 * - the request failed (the line went down, the lid closed): nothing counted, it waits for the link (`unreachable`);
 * - it stalled, the held file could not be read here (`local`), or that computer answered a 5xx: counted as a 5xx is
 *   (`filesFailed`), the next try under a new key (`files_try`, so it never waits behind a stuck upload there),
 *   refused after the outbox's tries;
 * - a 4xx: the answer is refused, a notice (`filesRefused`);
 * - the entry ended while its file went (taken back, its computer unlinked): the upload is stopped at once (`taken`).
 * An entry whose try failed waits out its own pause before the next, however often the lane is run (`PeerLink.request`
 * runs it after every answer); a line failure's pause ends when the link is back (`lineBack`).
 */

import { existsSync } from "node:fs";
import { inboxBlobPath } from "@plannotator/shared/inbox/attachments";
import { readInboxUpload } from "@plannotator/shared/inbox/uploads";
import { classifyAnswer, GATEWAY_STATUSES, outboxWaitsForFiles, type DrainResult, type InboxOutbox } from "./inbox-outbox";
import { outboxFileKey } from "./inbox-outbox-files";

/**
 * How long one file's upload may go with no byte moving (and, once its bytes are all sent, with no answer). A slow
 * file that keeps moving takes as long as it takes.
 */
export const OUTBOX_FILE_IDLE_MS = 30_000;
/** A file goes in pieces of at most this, so each piece the line takes counts as progress. */
const FILE_PIECE_BYTES = 64 * 1024;

/** One file to that computer's `uploads` route under its key, `size` bytes streamed from `body`. Throws when it cannot be reached or `signal` aborts. */
export type OutboxFileUpload = (file: { name: string; key: string; body: ReadableStream<Uint8Array>; size: number; signal: AbortSignal }) => Promise<Response>;

type UploadAnswer = { upload?: { upload_id?: unknown }; code?: unknown; error?: unknown };
export type OutboxFileTry =
  | { kind: "answer"; response: Response; answer: UploadAnswer }
  | { kind: "stalled" }
  | { kind: "failed" }
  | { kind: "local" }
  | { kind: "taken" };

/**
 * One file's upload, ended when no byte moves for `idleMs`: that computer's answer, `stalled` (no progress), `local`
 * (the held file could not be read here), `failed` (the request failed by itself: the line), or `taken` (`taken`
 * aborted: the entry ended). `watch` sees each piece pulled and the file closed (tests).
 */
export async function uploadOutboxFile(
  path: string,
  file: { name: string; key: string },
  upload: OutboxFileUpload,
  idleMs: number,
  watch: { pulled?: (bytes: number) => void; closed?: () => void } = {},
  taken?: AbortSignal,
): Promise<OutboxFileTry> {
  const blob = Bun.file(path);
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  // The file read here failed (an I/O error, the blob gone): this side's fault, never the line's.
  let local = false;
  const moved = () => {
    // A pull still running when the try ended never starts the clock again.
    if (ended) return;
    clearTimeout(timer);
    timer = setTimeout(() => stop.abort(), idleMs);
  };
  const takenBack = () => stop.abort();
  if (taken?.aborted) return { kind: "taken" };
  taken?.addEventListener("abort", takenBack, { once: true });
  const reader = (() => {
    try {
      return blob.stream().getReader();
    } catch {
      return null;
    }
  })();
  if (!reader) {
    taken?.removeEventListener("abort", takenBack);
    watch.closed?.();
    return { kind: "local" };
  }
  let rest = new Uint8Array(0);
  // Pulled only as the line takes the bytes (nothing read ahead), in pieces, so each pull is progress. The pull must
  // stay async: Bun's `fetch` drains a stream whose pull answers at once into memory, and waits on one that awaits
  // (inbox-outbox-file-wire.test.ts).
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        // A try that ended (stalled, taken back) never ends its body cleanly: that door must not take a part as the file.
        if (stop.signal.aborted) throw new Error("The upload was stopped.");
        if (rest.length === 0) {
          const next = await reader.read().catch((error: unknown) => {
            local = true;
            throw error;
          });
          if (stop.signal.aborted) throw new Error("The upload was stopped.");
          if (next.done) return controller.close();
          rest = next.value;
        }
        const piece = rest.subarray(0, FILE_PIECE_BYTES);
        rest = rest.subarray(piece.length);
        moved();
        watch.pulled?.(piece.length);
        controller.enqueue(piece);
      },
      cancel: (reason) => reader.cancel(reason).catch(() => {}),
    },
    { highWaterMark: 0 },
  );
  moved();
  try {
    const response = await upload({ name: file.name, key: file.key, body, size: blob.size, signal: stop.signal });
    const text = await response.text();
    if (taken?.aborted) return { kind: "taken" };
    // Whatever that computer said of a file cut short here, the cause was here.
    if (local) return { kind: "local" };
    if (stop.signal.aborted) return { kind: "stalled" };
    let answer: UploadAnswer = {};
    try {
      answer = (JSON.parse(text) ?? {}) as UploadAnswer;
    } catch {
      // Not JSON: no id, so its status says what it was.
    }
    return { kind: "answer", response, answer };
  } catch {
    // Taken back; the file unreadable here; our own limit; or the request failing by itself (the line): only the
    // last is not counted.
    if (taken?.aborted) return { kind: "taken" };
    if (local) return { kind: "local" };
    return stop.signal.aborted ? { kind: "stalled" } : { kind: "failed" };
  } finally {
    ended = true;
    clearTimeout(timer);
    taken?.removeEventListener("abort", takenBack);
    // The file's handle closed, however the request ended.
    await reader.cancel().catch(() => {});
    watch.closed?.();
  }
}

export interface FileLaneDeps {
  outbox: InboxOutbox;
  machine: string;
  /** The other computer's name, for a refusal that has no words of its own. */
  machineName: () => string;
  upload: OutboxFileUpload;
  idleMs: number;
  /** An entry's files are all there, or it ended: the write queue looks again. */
  onChange: () => void;
  /** An entry's pause after its first failed try, doubled after each one in a row up to `retryMaxMs`. */
  retryMinMs?: number;
  retryMaxMs?: number;
  now?: () => number;
}

const isPending = (state: string) => state === "queued" || state === "sending";

/** An entry's pause after a failed try: when it may go again, the pause it was, and whether the line was the cause. */
type Pause = { until: number; ms: number; line: boolean };

/** The lane of one linked computer. `run` while it runs makes it look again before it returns. */
export class OutboxFileLane {
  private running: Promise<DrainResult> | null = null;
  private again = false;
  private readonly paused = new Map<string, Pause>();

  constructor(private readonly deps: FileLaneDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** How long until the soonest paused entry may go again (0: now); null when none waits out a pause. */
  nextTryIn(): number | null {
    let soonest: number | null = null;
    for (const [key, pause] of this.paused) {
      const entry = this.deps.outbox.get(key);
      if (!entry || !isPending(entry.state) || !outboxWaitsForFiles(entry)) {
        this.paused.delete(key);
        continue;
      }
      soonest = Math.min(soonest ?? Infinity, Math.max(0, pause.until - this.now()));
    }
    return soonest;
  }

  /** The link is back (its hello): an entry paused because the line was down goes at the next run. */
  lineBack(): void {
    for (const [key, pause] of this.paused) if (pause.line) this.paused.delete(key);
  }

  private pause(key: string, line: boolean): void {
    const ms = Math.min(Math.max((this.paused.get(key)?.ms ?? 0) * 2, this.deps.retryMinMs ?? 1000), this.deps.retryMaxMs ?? 30_000);
    this.paused.set(key, { until: this.now() + ms, ms, line });
  }

  run(): Promise<DrainResult> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    const run = (async (): Promise<DrainResult> => {
      try {
        for (;;) {
          this.again = false;
          const result = await this.once();
          if (result !== "empty" || !this.again) return result;
        }
      } finally {
        this.running = null;
      }
    })();
    this.running = run;
    return run;
  }

  /**
   * Every entry still sending files, oldest first; one that failed lets the next go, and is tried again once its pause
   * is over: an entry still in its pause is passed by, however this run was started.
   */
  private async once(): Promise<DrainResult> {
    let failed = false;
    const tried = new Set<string>();
    for (;;) {
      const now = this.now();
      const entry = this.deps.outbox
        .list(this.deps.machine, "pending")
        .find((e) => outboxWaitsForFiles(e) && !tried.has(e.key) && (this.paused.get(e.key)?.until ?? 0) <= now);
      if (!entry) return failed ? "server_error" : "empty";
      tried.add(entry.key);
      const result = await this.sendFiles(entry.key);
      if (result === "unreachable" || result === "failed") this.pause(entry.key, result === "unreachable");
      else this.paused.delete(entry.key);
      if (result === "unreachable" || result === "revoked") return result;
      if (result === "failed") failed = true;
      else this.deps.onChange();
    }
  }

  private async sendFiles(key: string): Promise<"ready" | "settled" | "failed" | "unreachable" | "revoked"> {
    const { outbox } = this.deps;
    for (;;) {
      const entry = outbox.get(key);
      if (!entry || !isPending(entry.state)) return "settled";
      if (!outboxWaitsForFiles(entry)) return "ready";
      const sent = entry.sent_files ?? [];
      const index = sent.length;
      const file = entry.files![index]!;
      const attempt = entry.files_try ?? 0;
      const held = readInboxUpload(outbox.storeDir, file.upload);
      const path = held ? inboxBlobPath(outbox.storeDir, held.sha256) : null;
      if (!held || !path || !existsSync(path)) {
        outbox.filesRefused(key, { status: 422, body: { code: "upload_not_found", error: `${file.name} is no longer here.` } });
        return "settled";
      }
      const failed = { code: "upload_failed", error: `${file.name} could not be sent to ${this.deps.machineName()}.` };
      // Taken back, or its computer unlinked, while its file goes: the upload stops at once, and no other file starts.
      const taken = new AbortController();
      const unwatch = outbox.onChange(({ entry: changed }) => {
        if (changed.key === key && !isPending(changed.state)) taken.abort();
      });
      let tried: OutboxFileTry;
      try {
        tried = await uploadOutboxFile(path, { name: held.name, key: outboxFileKey(entry, attempt, index) }, this.deps.upload, this.deps.idleMs, {}, taken.signal);
      } finally {
        unwatch();
      }
      if (tried.kind === "taken") return "settled";
      if (tried.kind === "failed") return "unreachable";
      if (tried.kind === "stalled" || tried.kind === "local") {
        // A stuck or cut-short upload there may hold this key: the next try takes a new one; the stuck one is left to
        // its sweep. A file that cannot be read here fails every try, so it ends as a stall does, never retried for ever.
        outbox.noteSentFiles(key, sent, attempt + 1);
        outbox.filesFailed(key, { status: tried.kind === "stalled" ? 408 : 500, body: failed });
        return "failed";
      }
      const { response, answer } = tried;
      const id = answer.upload?.upload_id;
      if (response.ok && typeof id === "string") {
        outbox.noteSentFiles(key, [...sent, id], attempt);
        continue;
      }
      const verdict = classifyAnswer({ status: response.status, body: answer });
      if (verdict === "revoked") {
        outbox.dropMachine(this.deps.machine);
        return "revoked";
      }
      // A proxy's answer for an Inbox that never got the request: the line, not counted.
      if (GATEWAY_STATUSES.has(response.status)) return "unreachable";
      const words = { code: typeof answer.code === "string" ? answer.code : failed.code, error: typeof answer.error === "string" ? answer.error : failed.error };
      if (verdict === "retry") {
        outbox.filesFailed(key, { status: response.status, body: words });
        return "failed";
      }
      // A 4xx, or a 2xx without an id: that computer's refusal of the file, never a retry that could go on for ever.
      outbox.filesRefused(key, { status: response.ok ? 422 : response.status, body: words });
      return "settled";
    }
  }
}
