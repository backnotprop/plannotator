import { createHash } from "node:crypto";
import { mkdir, mkdtemp, unlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { INBOX_AGENT_FETCH_FILE } from "@plannotator/shared/inbox/agent-pairing";
import { FETCHED_FILE_WORDS, newSavedFile as newFile, savedFileName, savedNameIsDotenv } from "@plannotator/shared/inbox/saved-file";

type Refusal = { ok: false; code: string; message: string };
/** One call through the pairing: the result's structured content, or why not. */
export type PairedCall = (tool: string, args: Record<string, unknown>) => Promise<{ ok: true; structured?: Record<string, unknown> } | Refusal>;

export interface SavedFile {
  path: string;
  name: string;
  size: number;
  sha256: string;
  content_type: string;
}

interface Piece {
  name: string;
  size: number;
  sha256: string;
  content_type: string;
  offset: number;
  next_offset: number | null;
  data: string;
}

function pieceOf(value: Record<string, unknown> | undefined): Piece | null {
  const piece = value as Partial<Piece> | undefined;
  if (!piece || typeof piece.name !== "string" || typeof piece.size !== "number" || typeof piece.sha256 !== "string" || typeof piece.offset !== "number" || typeof piece.data !== "string") return null;
  if (piece.next_offset !== null && typeof piece.next_offset !== "number") return null;
  return { ...piece, content_type: typeof piece.content_type === "string" ? piece.content_type : "application/octet-stream" } as Piece;
}

export { savedFileName };

/**
 * `plannotator inbox call fetch_file` for a paired agent: asks for the file's
 * pieces in order, writes them to a new file in `folder` (relative to the
 * working folder) or a new temp folder, checks the size and SHA-256 the Inbox
 * gave, and answers where it saved it. A failure leaves no file behind.
 */
export async function fetchPairedFile(args: Record<string, unknown>, cwd: string, call: PairedCall): Promise<{ ok: true; saved: SavedFile } | Refusal> {
  const { folder, offset: _offset, ...ask } = args;
  if (folder !== undefined && (typeof folder !== "string" || folder.trim() === "")) return { ok: false, code: "invalid_arguments", message: "folder: a folder on this machine to save the file in." };
  let target: { path: string; handle: FileHandle } | null = null;
  const fail = async (refusal: Refusal): Promise<Refusal> => {
    if (target) {
      await target.handle.close().catch(() => {});
      await unlink(target.path).catch(() => {});
    }
    return refusal;
  };
  try {
    const hash = createHash("sha256");
    let first: Piece | null = null;
    let offset = 0;
    for (;;) {
      const got = await call(INBOX_AGENT_FETCH_FILE, { ...ask, offset });
      if (!got.ok) return await fail(got);
      const piece = pieceOf(got.structured);
      if (!piece || piece.offset !== offset || (first && (piece.size !== first.size || piece.sha256 !== first.sha256))) {
        return await fail({ ok: false, code: "fetch_broken", message: "The Inbox's answer was not the next piece of this file. Nothing was saved; fetch it again." });
      }
      if (!first) {
        // Never saved under a dotenv name, whatever the Inbox named it (as the command saves a linked machine's file).
        if (savedNameIsDotenv(piece.name)) return await fail({ ok: false, code: "attachment_refused", message: FETCHED_FILE_WORDS.dotenv(piece.name) });
        first = piece;
        const dir = typeof folder === "string" ? resolve(cwd, folder) : await mkdtemp(join(tmpdir(), "plannotator-file-"));
        await mkdir(dir, { recursive: true });
        target = await newFile(dir, savedFileName(piece.name));
      }
      const bytes = Buffer.from(piece.data, "base64");
      hash.update(bytes);
      await target!.handle.write(bytes, 0, bytes.length, offset);
      offset += bytes.length;
      if (piece.next_offset === null) break;
      if (piece.next_offset !== offset || bytes.length === 0) return await fail({ ok: false, code: "fetch_broken", message: "The Inbox's answer was not the next piece of this file. Nothing was saved; fetch it again." });
    }
    const sha256 = hash.digest("hex");
    if (offset !== first!.size || sha256 !== first!.sha256) {
      return await fail({ ok: false, code: "fetch_mismatch", message: `The pieces add up to ${offset} bytes with SHA-256 ${sha256}, not the ${first!.size} bytes and SHA-256 ${first!.sha256} the Inbox named. Nothing was saved; fetch it again.` });
    }
    await target!.handle.close();
    return { ok: true, saved: { path: target!.path, name: first!.name, size: offset, sha256, content_type: first!.content_type } };
  } catch (error) {
    return await fail({ ok: false, code: "fetch_unwritable", message: `Could not save the file here: ${error instanceof Error ? error.message : String(error)}` });
  }
}
