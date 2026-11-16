import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { INBOX_UPLOAD_MAX_BYTES } from "@plannotator/core/inbox-types";
import { INBOX_AGENT_UPLOAD_FINISH, INBOX_AGENT_UPLOAD_PIECE } from "@plannotator/shared/inbox/agent-pairing";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { inboxUploadNameRefusal } from "@plannotator/shared/inbox/uploads";
import { okComplete, type ToolResult } from "./inbox-mcp-result";

export const INBOX_AGENT_PIECES_DIR = "agent-pieces";
export const INBOX_AGENT_PIECES_KEEP_MS = 24 * 60 * 60 * 1000;
export const INBOX_AGENT_PIECE_MAX_BYTES = 16 * 1024 * 1024;

const UPLOAD_ID = /^[A-Za-z0-9_-]{8,64}$/;
const PIECE_FILE = /^(\d{1,5})\.part$/;
const FILE = "file";
const META = "meta.json";
const MB = 1024 * 1024;

interface Finished {
  name: string;
  size: number;
  sha256: string;
}

const refuse = (code: string, message: string) => new InboxError(code, message);

export function createInboxAgentPieces(inboxDirPath: string, now: () => number = Date.now) {
  const root = join(inboxDirPath, INBOX_AGENT_PIECES_DIR);

  const sweep = () => {
    let sessions: string[];
    try {
      sessions = readdirSync(root);
    } catch {
      return;
    }
    for (const session of sessions) {
      const dir = join(root, session);
      let uploads: string[];
      try {
        uploads = readdirSync(dir);
      } catch {
        continue;
      }
      for (const upload of uploads) {
        const path = join(dir, upload);
        try {
          if (now() - statSync(path).mtimeMs > INBOX_AGENT_PIECES_KEEP_MS) rmSync(path, { recursive: true, force: true });
        } catch {
          continue;
        }
      }
    }
  };

  const placeOf = (session: string, uploadId: unknown): string => {
    if (typeof uploadId !== "string" || !UPLOAD_ID.test(uploadId)) throw refuse("validation_error", "upload_id: 8 to 64 letters, digits, - or _.");
    return join(root, session, uploadId);
  };

  const pieces = (place: string) => {
    let names: string[];
    try {
      names = readdirSync(place);
    } catch {
      return [];
    }
    return names
      .map((name) => PIECE_FILE.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({ index: Number(match[1]), path: join(place, match[0]) }))
      .sort((a, b) => a.index - b.index);
  };

  const finished = (place: string): Finished | null => {
    try {
      return JSON.parse(readFileSync(join(place, META), "utf8")) as Finished;
    } catch {
      return null;
    }
  };

  const piece = (session: string, uploadId: unknown, index: unknown, bytes: Uint8Array) => {
    sweep();
    const place = placeOf(session, uploadId);
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index > 99_999) throw refuse("validation_error", "index: the piece's place, a whole number from 0.");
    if (bytes.length === 0) throw refuse("validation_error", "data: a piece holds at least one byte.");
    if (bytes.length > INBOX_AGENT_PIECE_MAX_BYTES) throw refuse("piece_too_large", `data: a piece is at most ${INBOX_AGENT_PIECE_MAX_BYTES / MB} MB.`);
    const target = `${index}.part`;
    const others = pieces(place).filter((p) => p.index !== index).reduce((sum, p) => sum + statSync(p.path).size, 0);
    if (others + bytes.length > INBOX_UPLOAD_MAX_BYTES) {
      rmSync(place, { recursive: true, force: true });
      throw refuse("upload_too_large", `A file is at most ${INBOX_UPLOAD_MAX_BYTES / MB} MB. This upload was dropped.`);
    }
    mkdirSync(place, { recursive: true, mode: 0o700 });
    const temp = join(place, `${target}.tmp`);
    writeFileSync(temp, bytes, { mode: 0o600 });
    renameSync(temp, join(place, target));
    return { upload_id: uploadId as string, index, received: others + bytes.length };
  };

  const finish = (session: string, uploadId: unknown, name: unknown, size: unknown, sha256: unknown) => {
    sweep();
    const place = placeOf(session, uploadId);
    const nameRefusal = inboxUploadNameRefusal(name);
    if (nameRefusal) throw refuse("upload_refused", `name: ${nameRefusal}`);
    if (typeof size !== "number" || !Number.isInteger(size) || size < 1) throw refuse("validation_error", "size: the file's size in bytes.");
    if (size > INBOX_UPLOAD_MAX_BYTES) {
      rmSync(place, { recursive: true, force: true });
      throw refuse("upload_too_large", `A file is at most ${INBOX_UPLOAD_MAX_BYTES / MB} MB. This upload was dropped.`);
    }
    if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) throw refuse("validation_error", "sha256: the file's SHA-256, 64 lowercase hex digits.");
    const done = finished(place);
    if (done && existsSync(join(place, FILE))) {
      if (done.size === size && done.sha256 === sha256) return { upload: uploadId as string, name: done.name, size };
      throw refuse("upload_mismatch", "This upload already finished as other bytes. Send the file again under a new upload_id.");
    }
    const list = pieces(place);
    if (list.length === 0) throw refuse("upload_not_found", "No pieces arrived under this upload_id, or they were dropped after a day. Send them again.");
    const missing = list.findIndex((p, i) => p.index !== i);
    if (missing >= 0) throw refuse("upload_incomplete", `Piece ${missing} has not arrived. Send it, then finish again.`);
    const hash = createHash("sha256");
    const temp = join(place, `${FILE}.tmp`);
    const out = openSync(temp, "w", 0o600);
    let total = 0;
    try {
      for (const p of list) {
        const bytes = readFileSync(p.path);
        total += bytes.length;
        hash.update(bytes);
        writeSync(out, bytes);
      }
    } finally {
      closeSync(out);
    }
    const got = hash.digest("hex");
    if (total !== size || got !== sha256) {
      rmSync(place, { recursive: true, force: true });
      throw refuse("upload_mismatch", `The pieces add up to ${total} bytes with SHA-256 ${got}, not the ${size} bytes and SHA-256 you named. This upload was dropped; send the file again.`);
    }
    renameSync(temp, join(place, FILE));
    writeFileSync(join(place, META), JSON.stringify({ name: name as string, size, sha256 } satisfies Finished), { mode: 0o600 });
    for (const p of list) rmSync(p.path, { force: true });
    return { upload: uploadId as string, name: name as string, size };
  };

  const take = (session: string, uploadId: unknown): { name: string; path: string; drop: () => void } => {
    const place = placeOf(session, uploadId);
    const done = finished(place);
    if (!done || !existsSync(join(place, FILE))) throw refuse("upload_not_found", `${uploadId}: no finished upload of yours has this id. Send its pieces and finish it first; an upload is kept a day.`);
    return { name: done.name, path: join(place, FILE), drop: () => rmSync(place, { recursive: true, force: true }) };
  };

  return { piece, finish, take, sweep };
}

export type InboxAgentPieces = ReturnType<typeof createInboxAgentPieces>;

export function bytesOfBase64(data: unknown): Buffer | null {
  if (typeof data !== "string" || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(data)) return null;
  return Buffer.from(data, data.includes("-") || data.includes("_") ? "base64url" : "base64");
}

const FIELDS: Record<string, readonly string[]> = {
  [INBOX_AGENT_UPLOAD_PIECE]: ["upload_id", "index", "data"],
  [INBOX_AGENT_UPLOAD_FINISH]: ["upload_id", "name", "size", "sha256"],
};

export function inboxAgentPieceAction(pieces: InboxAgentPieces, session: string, tool: string, args: Record<string, unknown>): ToolResult | null {
  const fields = FIELDS[tool];
  if (!fields) return null;
  const extra = Object.keys(args).find((field) => !fields.includes(field));
  if (extra) throw refuse("validation_error", `${extra}: not taken. ${tool} takes: ${fields.join(", ")}.`);
  if (tool === INBOX_AGENT_UPLOAD_PIECE) {
    const bytes = bytesOfBase64(args.data);
    if (!bytes) throw refuse("validation_error", "data: the piece's bytes as base64.");
    const got = pieces.piece(session, args.upload_id, args.index, bytes);
    return okComplete(`Piece ${got.index} of ${got.upload_id} arrived (${got.received} bytes so far).`, got);
  }
  const done = pieces.finish(session, args.upload_id, args.name, args.size, args.sha256);
  return okComplete(`${done.name} arrived whole (${done.size} bytes). Attach it with { "upload": "${done.upload}" } in send_message's attachments.`, done);
}
