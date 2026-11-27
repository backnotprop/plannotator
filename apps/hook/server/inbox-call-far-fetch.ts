/**
 * `plannotator inbox call fetch_file` for an agent on this computer: a file of a thread on a linked machine
 * (read_thread lists each with the command; packages/server/inbox-far-read.ts). This computer's Inbox asks that
 * machine through their link and streams the bytes back; this command saves them, in its own process, in a new temp
 * folder or in `folder`, so the agent's own sandbox decides where it may write. It checks the name (no dotenv name, as
 * saved), the size (at most 100 MB, and what the Inbox named) and the SHA-256, and prints where it saved the file. A
 * failure leaves no file behind. A paired cloud agent's fetch_file goes through its pairing instead
 * (inbox-call-fetch.ts).
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, unlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import {
  FETCHED_FILE_MACHINE_HEADER,
  FETCHED_FILE_MAX_BYTES,
  FETCHED_FILE_NAME_HEADER,
  FETCHED_FILE_SHA_HEADER,
  FETCHED_FILE_SIZE_HEADER,
  FETCHED_FILE_WORDS,
  fetchedNameOf,
  fetchedShaOf,
  fetchedSizeOf,
  fetchedTypeOf,
  newSavedFile,
  savedFileName,
  savedNameIsDotenv,
} from "@plannotator/shared/inbox/saved-file";

type Refusal = { ok: false; code: string; message: string };

/** What it prints: where the file is, and what it is. */
export interface FarSavedFile {
  path: string;
  name: string;
  size: number;
  sha256: string;
  content_type: string;
  machine: string;
}

/** The fields it takes. */
const FIELDS = ["message_id", "file", "folder"] as const;

/** The Inbox asks the other machine for at most 5 s; past this its answer is not coming. */
const FAR_FETCH_ANSWER_MS = 60_000;
/** Bytes that stop arriving for this long end the fetch (the Inbox gives up after 30 s itself, and says so). */
const FAR_FETCH_STALL_MS = 45_000;

export interface FarFetchTimings {
  answerMs?: number;
  stallMs?: number;
}

export async function fetchFarFile(
  args: Record<string, unknown>,
  cwd: string,
  entry: Pick<InboxRegistryEntry, "port" | "token">,
  fetchImpl: typeof fetch = fetch,
  timings: FarFetchTimings = {},
): Promise<{ ok: true; saved: FarSavedFile } | Refusal> {
  const extra = Object.keys(args).find((field) => !(FIELDS as readonly string[]).includes(field));
  if (extra) return { ok: false, code: "invalid_arguments", message: `${extra}: not taken. fetch_file takes: ${FIELDS.join(", ")}.` };
  const { folder } = args;
  if (folder !== undefined && (typeof folder !== "string" || folder.trim() === "")) return { ok: false, code: "invalid_arguments", message: "folder: a folder on this machine to save the file in." };
  // The folder stays here: the Inbox is told only which file.
  const body = { message_id: args.message_id, file: args.file };
  const giveUp = new AbortController();
  const answerTimer = setTimeout(() => giveUp.abort(), timings.answerMs ?? FAR_FETCH_ANSWER_MS);
  let response: Response;
  try {
    response = await fetchImpl(`http://127.0.0.1:${entry.port}/api/inbox/control/machines/fetch-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${entry.token}` },
      body: JSON.stringify(body),
      signal: giveUp.signal,
    });
  } catch (error) {
    return { ok: false, code: "inbox_no_answer", message: `Plannotator Inbox did not answer: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(answerTimer);
  }
  if (!response.ok || !response.headers.has(FETCHED_FILE_NAME_HEADER)) {
    const answer = (await response.json().catch(() => null)) as { code?: unknown; error?: unknown } | null;
    // An Inbox from before this route answers its control routes' 404: it is older than this command.
    if (response.status === 404 && answer?.code === "not_found") return { ok: false, code: "inbox_too_old", message: "This computer's Plannotator Inbox is older than this command: restart it (plannotator inbox restart) and try again." };
    return { ok: false, code: typeof answer?.code === "string" ? answer.code : "inbox_error", message: typeof answer?.error === "string" ? answer.error : `The Inbox answered ${response.status}.` };
  }
  return saveStreamed(response, typeof folder === "string" ? resolve(cwd, folder) : null, giveUp, timings.stallMs ?? FAR_FETCH_STALL_MS);
}

/** The Inbox's streamed answer saved as a new file here: checked before a byte is written, as it streams, and at its end. */
async function saveStreamed(response: Response, folder: string | null, giveUp: AbortController, stallMs: number): Promise<{ ok: true; saved: FarSavedFile } | Refusal> {
  const name = fetchedNameOf(response.headers.get(FETCHED_FILE_NAME_HEADER));
  const sha256 = fetchedShaOf(response.headers.get(FETCHED_FILE_SHA_HEADER));
  const declared = fetchedSizeOf(response.headers.get(FETCHED_FILE_SIZE_HEADER));
  const machine = response.headers.get(FETCHED_FILE_MACHINE_HEADER) ?? "";
  const stop = () => {
    giveUp.abort();
    void response.body?.cancel().catch(() => {});
  };
  let target: { path: string; handle: FileHandle } | null = null;
  const fail = async (code: string, message: string): Promise<Refusal> => {
    stop();
    if (target) {
      await target.handle.close().catch(() => {});
      await unlink(target.path).catch(() => {});
    }
    return { ok: false, code, message };
  };
  // The name it is saved under, as this computer's file system keeps it, is what must not be a dotenv one.
  if (savedNameIsDotenv(name)) return fail("attachment_refused", FETCHED_FILE_WORDS.dotenv(name));
  if (declared !== null && declared > FETCHED_FILE_MAX_BYTES) return fail("file_too_large", FETCHED_FILE_WORDS.tooLarge(name, declared));
  if (declared === null || sha256 === null || !response.body) return fail("fetch_broken", `The Inbox's answer for ${name} did not say its size and SHA-256. Nothing was saved; fetch it again.`);
  try {
    const dir = folder ?? (await mkdtemp(join(tmpdir(), "plannotator-file-")));
    await mkdir(dir, { recursive: true });
    target = await newSavedFile(dir, savedFileName(name));
  } catch (error) {
    return fail("fetch_unwritable", `Could not save the file here: ${error instanceof Error ? error.message : String(error)}`);
  }
  const hash = createHash("sha256");
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<"stalled">((resolveStall) => (timer = setTimeout(() => resolveStall("stalled"), stallMs)));
    let next: Awaited<ReturnType<typeof reader.read>> | "stalled";
    try {
      next = await Promise.race([reader.read(), stalled]);
    } catch {
      return fail("machine_offline", FETCHED_FILE_WORDS.stopped(name));
    } finally {
      clearTimeout(timer);
    }
    if (next === "stalled") return fail("machine_offline", FETCHED_FILE_WORDS.stopped(name));
    if (next.done) break;
    size += next.value.byteLength;
    if (size > FETCHED_FILE_MAX_BYTES) return fail("file_too_large", FETCHED_FILE_WORDS.over(name));
    if (size > declared) return fail("fetch_mismatch", FETCHED_FILE_WORDS.mismatch(name, size, hash.update(next.value).digest("hex")));
    hash.update(next.value);
    try {
      await target.handle.write(next.value);
    } catch (error) {
      return fail("fetch_unwritable", `Could not save the file here: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const got = hash.digest("hex");
  if (size < declared) return fail("machine_offline", FETCHED_FILE_WORDS.stopped(name));
  if (got !== sha256) return fail("fetch_mismatch", FETCHED_FILE_WORDS.mismatch(name, size, got));
  await target.handle.close();
  return { ok: true, saved: { path: target.path, name, size, sha256: got, content_type: fetchedTypeOf(response.headers.get("content-type")), machine } };
}
