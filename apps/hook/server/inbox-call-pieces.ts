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

async function sendInPieces(path: string, item: string, send: PairedSend): Promise<{ ok: true; upload: string } | Refusal> {
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
  const done = await send(INBOX_AGENT_UPLOAD_FINISH, { upload_id: uploadId, name: basename(path), size, sha256: hash.digest("hex") });
  return done.ok ? { ok: true, upload: uploadId } : done;
}

export async function pairedAttachments(items: readonly unknown[], cwd: string, send: PairedSend): Promise<{ ok: true; items: unknown[] } | Refusal> {
  const sent: unknown[] = [];
  let inline = 0;
  try {
    for (const item of items) {
      if (typeof item !== "string") {
        sent.push(item);
        continue;
      }
      const path = resolve(cwd, item);
      const size = (await stat(path)).size;
      if (size > INBOX_UPLOAD_MAX_BYTES) return tooLarge(item, size);
      if (inline + size <= INBOX_CALL_PIECE_BYTES) {
        inline += size;
        sent.push({ name: basename(path), data: (await readFile(path)).toString("base64") });
        continue;
      }
      const upload = await sendInPieces(path, item, send);
      if (!upload.ok) return upload;
      sent.push({ upload: upload.upload });
    }
  } catch (error) {
    return { ok: false, code: "attachment_unreadable", message: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, items: sent };
}
