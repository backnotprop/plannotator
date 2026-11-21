import { createHash, randomBytes } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { INBOX_UPLOAD_MAX_BYTES } from "@plannotator/core/inbox-types";
import { INBOX_AGENT_UPLOAD_FINISH, INBOX_AGENT_UPLOAD_PIECE } from "@plannotator/shared/inbox/agent-pairing";

export const INBOX_CALL_PIECE_BYTES = 8 * 1024 * 1024;

type Refusal = { ok: false; code: string; message: string };
export type PairedSend = (tool: string, args: Record<string, unknown>) => Promise<{ ok: true } | Refusal>;

const MB = 1024 * 1024;
const tooLarge = (item: string, size: number): Refusal => ({
  ok: false,
  code: "attachment_too_large",
  message: `${item} is ${size} bytes; a file is at most ${INBOX_UPLOAD_MAX_BYTES / MB} MB. Nothing was sent.`,
});

async function sendInPieces(path: string, item: string, send: PairedSend, name = basename(path)): Promise<{ ok: true; upload: string } | Refusal> {
  const uploadId = randomBytes(18).toString("base64url");
  const hash = createHash("sha256");
  const handle = await open(path, "r");
  let size = 0;
  try {
    for (let index = 0; ; index++) {
      const buffer = Buffer.allocUnsafe(INBOX_CALL_PIECE_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
      if (bytesRead === 0) break;
      const piece = buffer.subarray(0, bytesRead);
      size += bytesRead;
      if (size > INBOX_UPLOAD_MAX_BYTES) return tooLarge(item, size);
      hash.update(piece);
      const sent = await send(INBOX_AGENT_UPLOAD_PIECE, { upload_id: uploadId, index, data: piece.toString("base64") });
      if (!sent.ok) return sent;
    }
  } finally {
    await handle.close();
  }
  const done = await send(INBOX_AGENT_UPLOAD_FINISH, { upload_id: uploadId, name, size, sha256: hash.digest("hex") });
  return done.ok ? { ok: true, upload: uploadId } : done;
}

/** Whether `path` is a regular file on this machine. */
async function isFileHere(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** `{ "path": "…" }`: a path on the person's computer, named so; never looked for on this machine. */
const personsPath = (item: unknown): string | null =>
  item && typeof item === "object" && !Array.isArray(item) && Object.keys(item).length === 1 && typeof (item as { path?: unknown }).path === "string" ? (item as { path: string }).path : null;

/**
 * The send's attachments as the door takes them: a path that is a file on this machine read and sent as bytes (a big
 * file in pieces); any other path (one that is not here, or a folder here) as it is, for the Inbox to open on the
 * person's computer as a local agent's, and `{ "path": "…" }` as that path, whatever is here; every other item as it
 * is. `named`: more files to send under a given name (the body's pictures, planAgentBodyPictures). `remote`: the
 * places in `items` of the paths left for the person's computer, so a refusal of one can say where it was looked for.
 */
export async function pairedAttachments(items: readonly unknown[], cwd: string, send: PairedSend, named: readonly { path: string; name: string }[] = []): Promise<{ ok: true; items: unknown[]; remote: number[] } | Refusal> {
  const sent: unknown[] = [];
  const remote: number[] = [];
  let inline = 0;
  type File = { path: string; name: string; label: string };
  const all: (File | { item: unknown })[] = [
    ...(await Promise.all(
      items.map(async (item, i) => {
        const there = personsPath(item);
        if (there !== null) {
          remote.push(i);
          return { item: there };
        }
        if (typeof item === "string" && (await isFileHere(resolve(cwd, item)))) return { path: resolve(cwd, item), name: basename(resolve(cwd, item)), label: item };
        if (typeof item === "string") remote.push(i);
        return { item };
      }),
    )),
    ...named.map((file) => ({ ...file, label: file.path })),
  ];
  try {
    for (const file of all) {
      if ("item" in file) {
        sent.push(file.item);
        continue;
      }
      const { path, name, label } = file;
      const size = (await stat(path)).size;
      if (size > INBOX_UPLOAD_MAX_BYTES) return tooLarge(label, size);
      if (inline + size <= INBOX_CALL_PIECE_BYTES) {
        inline += size;
        sent.push({ name, data: (await readFile(path)).toString("base64") });
        continue;
      }
      const upload = await sendInPieces(path, label, send, name);
      if (!upload.ok) return upload;
      sent.push({ upload: upload.upload });
    }
  } catch (error) {
    return { ok: false, code: "attachment_unreadable", message: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, items: sent, remote: remote.sort((a, b) => a - b) };
}
