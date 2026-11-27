/**
 * A paired cloud agent's fetch_file of a file on a linked machine (the owner: "Whatever I can do locally, I should be
 * able to do from a cloud instance"): the person's computer asks that machine's `agent-file` door for one piece, by
 * `offset` and `length` (inbox-far-read.ts), and answers it in the agent door's pieces protocol (`offset`,
 * `next_offset`, the whole file's size and SHA-256, base64 data), as for a file of its own (inbox-agent-files.ts).
 * The piece lives in memory for this answer only: nothing is written here. The cloud command puts the pieces together
 * and checks the name as saved, the size and the SHA-256 (apps/hook/server/inbox-call-fetch.ts).
 */

import { FETCHED_FILE_MAX_BYTES, FETCHED_FILE_SIZE_HEADER, FETCHED_FILE_WORDS, fetchedNameOf, fetchedShaOf, fetchedSizeOf, fetchedTypeOf, savedNameIsDotenv } from "@plannotator/shared/inbox/saved-file";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { AGENT_FILE_NAME_HEADER, AGENT_FILE_OFFSET_HEADER, AGENT_FILE_PIECE_MAX_BYTES, AGENT_FILE_SHA_HEADER } from "./inbox-far-read";

/** How long one piece may take, headers and bytes: 1 MiB over the tailnet. */
export const FAR_PIECE_WAIT_MS = 20_000;

/** At most this many far pieces are read at once for one cloud agent (each up to 1 MiB in memory); the rest wait their turn. */
export const FAR_PIECES_AT_ONCE = 2;

/** Turns per caller: `run` waits while `max` of that caller's runs are going, then runs. */
export function createTurns(max = FAR_PIECES_AT_ONCE) {
  const going = new Map<string, number>();
  const queued = new Map<string, (() => void)[]>();
  return async <T>(caller: string, run: () => Promise<T>): Promise<T> => {
    // A finished run hands its turn straight to the next one waiting, so the count never overshoots.
    if ((going.get(caller) ?? 0) >= max) await new Promise<void>((resolve) => queued.set(caller, [...(queued.get(caller) ?? []), resolve]));
    else going.set(caller, (going.get(caller) ?? 0) + 1);
    try {
      return await run();
    } finally {
      const waiting = queued.get(caller);
      const next = waiting?.shift();
      if (waiting && waiting.length === 0) queued.delete(caller);
      if (next) next();
      else if ((going.get(caller) ?? 1) <= 1) going.delete(caller);
      else going.set(caller, going.get(caller)! - 1);
    }
  };
}

/** One piece, as the agent door's fetch_file answers it. */
export interface FarFilePiece {
  name: string;
  content_type: string;
  size: number;
  sha256: string;
  offset: number;
  next_offset: number | null;
  data: string;
}

/**
 * A far piece answer as this computer hands it on: refused when its name is a dotenv one, its file is past 100 MB, or
 * its size, SHA-256 or bytes do not add up; `older` when that door read the whole file (no offset said: a Plannotator
 * before piece reads).
 */
export async function farPieceOf(response: Response, offset: number, words: { older: string; unreadable: string }): Promise<FarFilePiece> {
  const cancel = () => void response.body?.cancel().catch(() => {});
  if (response.headers.get(AGENT_FILE_OFFSET_HEADER) !== String(offset)) {
    cancel();
    throw new InboxError("machine_needs_update", words.older);
  }
  const name = fetchedNameOf(response.headers.get(AGENT_FILE_NAME_HEADER));
  const sha256 = fetchedShaOf(response.headers.get(AGENT_FILE_SHA_HEADER));
  const size = fetchedSizeOf(response.headers.get(FETCHED_FILE_SIZE_HEADER));
  const unreadable = () => new InboxError("machine_answer_unreadable", words.unreadable);
  if (savedNameIsDotenv(name)) {
    cancel();
    throw new InboxError("attachment_refused", FETCHED_FILE_WORDS.dotenv(name));
  }
  if (size !== null && size > FETCHED_FILE_MAX_BYTES) {
    cancel();
    throw new InboxError("file_too_large", FETCHED_FILE_WORDS.tooLarge(name, size));
  }
  if (size === null || sha256 === null || offset > size) {
    cancel();
    throw unreadable();
  }
  const want = Math.min(AGENT_FILE_PIECE_MAX_BYTES, size - offset);
  const bytes = await bytesOf(response, want);
  if (bytes === null) throw unreadable();
  return { name, content_type: fetchedTypeOf(response.headers.get("content-type")), size, sha256, offset, next_offset: offset + want < size ? offset + want : null, data: bytes.toString("base64") };
}

/** Exactly `want` bytes of a body, else null (fewer, more, or a line that dropped): its stream is let go either way. */
async function bytesOf(response: Response, want: number): Promise<Buffer | null> {
  const reader = response.body?.getReader();
  if (!reader) return want === 0 ? Buffer.alloc(0) : null;
  const chunks: Uint8Array[] = [];
  let got = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return got === want ? Buffer.concat(chunks) : null;
      got += next.value.byteLength;
      if (got > want) break;
      chunks.push(next.value);
    }
  } catch {
    // The line dropped, or the wait ran out.
  }
  void reader.cancel().catch(() => {});
  return null;
}
