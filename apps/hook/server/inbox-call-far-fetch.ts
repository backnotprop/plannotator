/**
 * `plannotator inbox call fetch_file` for an agent on this computer: a file of a thread on a linked machine
 * (read_thread lists each with the command; packages/server/inbox-far-read.ts). This computer's Inbox asks that
 * machine through their link and saves the file here, in a new temp folder or in `folder`, and the command prints
 * where. A paired cloud agent's fetch_file goes through its pairing instead (inbox-call-fetch.ts).
 */

import { resolve } from "node:path";
import type { InboxRegistryEntry } from "@plannotator/shared/inbox/registry";

type Refusal = { ok: false; code: string; message: string };

/** The fields it takes. */
const FIELDS = ["message_id", "file", "folder"] as const;

/** A whole file may take a while over a slow link: the Inbox itself gives up on a stalled one. */
const FAR_FETCH_TIMEOUT_MS = 15 * 60_000;

export async function fetchFarFile(
  args: Record<string, unknown>,
  cwd: string,
  entry: Pick<InboxRegistryEntry, "port" | "token">,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; saved: Record<string, unknown> } | Refusal> {
  const extra = Object.keys(args).find((field) => !(FIELDS as readonly string[]).includes(field));
  if (extra) return { ok: false, code: "invalid_arguments", message: `${extra}: not taken. fetch_file takes: ${FIELDS.join(", ")}.` };
  const { folder } = args;
  if (folder !== undefined && (typeof folder !== "string" || folder.trim() === "")) return { ok: false, code: "invalid_arguments", message: "folder: a folder on this machine to save the file in." };
  const body = { message_id: args.message_id, file: args.file, ...(typeof folder === "string" ? { folder: resolve(cwd, folder) } : {}) };
  try {
    const response = await fetchImpl(`http://127.0.0.1:${entry.port}/api/inbox/control/machines/fetch-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${entry.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FAR_FETCH_TIMEOUT_MS),
    });
    const answer = (await response.json().catch(() => null)) as { saved?: Record<string, unknown>; code?: unknown; error?: unknown } | null;
    if (response.ok && answer?.saved && typeof answer.saved.path === "string") return { ok: true, saved: answer.saved };
    // An Inbox from before this route answers its control routes' 404: it is older than this command.
    if (response.status === 404 && answer?.code === "not_found") return { ok: false, code: "inbox_too_old", message: "This computer's Plannotator Inbox is older than this command: restart it (plannotator inbox restart) and try again." };
    return { ok: false, code: typeof answer?.code === "string" ? answer.code : "inbox_error", message: typeof answer?.error === "string" ? answer.error : `The Inbox answered ${response.status}.` };
  } catch (error) {
    return { ok: false, code: "inbox_no_answer", message: `Plannotator Inbox did not answer: ${error instanceof Error ? error.message : String(error)}` };
  }
}
