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
 * - it stalled, or that computer answered a 5xx: counted as a 5xx is (`filesFailed`), the next try under a new key
 *   (`files_try`, so it never waits behind a stuck upload there), refused after the outbox's tries;
 * - a 4xx: the answer is refused, a notice (`filesRefused`).
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
export type OutboxFileTry = { kind: "answer"; response: Response; answer: UploadAnswer } | { kind: "stalled" } | { kind: "failed" };

/**
 * One file's upload, ended when no byte moves for `idleMs`: that computer's answer, `stalled` (no progress), or
 * `failed` (the request failed by itself: the line). `watch` sees each piece pulled and the file closed (tests).
 */
export async function uploadOutboxFile(
  path: string,
  file: { name: string; key: string },
  upload: OutboxFileUpload,
  idleMs: number,
  watch: { pulled?: (bytes: number) => void; closed?: () => void } = {},
): Promise<OutboxFileTry> {
  const blob = Bun.file(path);
  const stop = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  const moved = () => {
    // A pull still running when the try ended never starts the clock again.
    if (ended) return;
    clearTimeout(timer);
    timer = setTimeout(() => stop.abort(), idleMs);
  };
  const reader = blob.stream().getReader();
  let rest = new Uint8Array(0);
  // Pulled only as the line takes the bytes (nothing read ahead), in pieces, so each pull is progress. The pull must
  // stay async: Bun's `fetch` drains a stream whose pull answers at once into memory, and waits on one that awaits
  // (inbox-outbox-file-wire.test.ts).
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        if (rest.length === 0) {
          const next = await reader.read();
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
    if (stop.signal.aborted) return { kind: "stalled" };
    let answer: UploadAnswer = {};
    try {
      answer = (JSON.parse(text) ?? {}) as UploadAnswer;
    } catch {
      // Not JSON: no id, so its status says what it was.
    }
    return { kind: "answer", response, answer };
  } catch {
    // Our own limit, or the request failing by itself (the line): only the first is counted.
    return stop.signal.aborted ? { kind: "stalled" } : { kind: "failed" };
  } finally {
    ended = true;
    clearTimeout(timer);
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
}

const isPending = (state: string) => state === "queued" || state === "sending";

/** The lane of one linked computer. `run` while it runs makes it look again before it returns. */
export class OutboxFileLane {
  private running: Promise<DrainResult> | null = null;
  private again = false;

  constructor(private readonly deps: FileLaneDeps) {}

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

  /** Every entry still sending files, oldest first; one that failed lets the next go, and is tried again later. */
  private async once(): Promise<DrainResult> {
    let failed = false;
    const tried = new Set<string>();
    for (;;) {
      const entry = this.deps.outbox.list(this.deps.machine, "pending").find((e) => outboxWaitsForFiles(e) && !tried.has(e.key));
      if (!entry) return failed ? "server_error" : "empty";
      tried.add(entry.key);
      const result = await this.sendFiles(entry.key);
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
      const tried = await uploadOutboxFile(path, { name: held.name, key: outboxFileKey(entry, attempt, index) }, this.deps.upload, this.deps.idleMs);
      if (tried.kind === "failed") return "unreachable";
      if (tried.kind === "stalled") {
        // A stuck upload there may hold this key: the next try takes a new one; the stuck one is left to its sweep.
        outbox.noteSentFiles(key, sent, attempt + 1);
        outbox.filesFailed(key, { status: 408, body: failed });
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
