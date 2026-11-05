/**
 * Plannotator Inbox: Show me's drawings (code review in the Inbox, approval
 * "shape-in-code-review"), the pictures an agent sent for the person's Show me
 * on a review.
 *
 *   inbox/review-drawings/<review msg id>.json   one per review, 0600 in a 0700 folder, written whole
 *
 * Beside the Ask files and outside the event log, as they are: the window's
 * stream, read_thread, search and the phone relay never see a drawing. The Ask
 * turn a drawing answers carries only its id (`drawing`), so a picture never
 * travels inside the answer text. A file that cannot be read, or does not
 * parse, throws: taking it for "none" would let the next write replace it.
 */

import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { isInboxId } from "@plannotator/core/inbox-types";
import type { InboxReviewDrawing } from "@plannotator/core/inbox-review";
import { InboxError } from "./schema";

export const INBOX_REVIEW_DRAWINGS_DIR = "review-drawings";
/** The most drawings one review keeps: Show me is a person's click, so this is far past any real review. */
export const INBOX_REVIEW_DRAWINGS_MAX = 200;

export interface InboxReviewDrawings {
  v: 1;
  review: string;
  drawings: InboxReviewDrawing[];
}

const dirOf = (inboxDirPath: string): string => join(inboxDirPath, INBOX_REVIEW_DRAWINGS_DIR);
const fileOf = (inboxDirPath: string, reviewId: string): string => join(dirOf(inboxDirPath), `${reviewId}.json`);

/** A drawing id: `drw_` and 26 Crockford characters, like the Inbox's own ids. */
export function inboxDrawingId(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = randomBytes(26);
  let id = "drw_";
  for (const byte of bytes) id += alphabet[byte % 32];
  return id;
}

/** One review's drawings, oldest first; none when it has no file. */
export function readInboxReviewDrawings(inboxDirPath: string, reviewId: string): InboxReviewDrawing[] {
  if (!isInboxId("msg", reviewId)) return [];
  let text: string;
  try {
    text = readFileSync(fileOf(inboxDirPath, reviewId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new InboxError("drawings_unreadable", "This review's drawings can't be read right now. Nothing was changed.");
  }
  try {
    const value = JSON.parse(text) as InboxReviewDrawings;
    if (value?.v !== 1 || value.review !== reviewId || !Array.isArray(value.drawings)) throw new Error("shape");
    return value.drawings;
  } catch {
    throw new InboxError("drawings_damaged", "This review's drawings are damaged and can't be shown. Nothing was changed.");
  }
}

/** Add one drawing to a review's file (written whole: temp, then rename). */
export function addInboxReviewDrawing(inboxDirPath: string, reviewId: string, drawing: InboxReviewDrawing): InboxReviewDrawing {
  const drawings = readInboxReviewDrawings(inboxDirPath, reviewId);
  if (drawings.length >= INBOX_REVIEW_DRAWINGS_MAX) throw new InboxError("drawings_full", `This review keeps ${INBOX_REVIEW_DRAWINGS_MAX} drawings at most.`);
  const file: InboxReviewDrawings = { v: 1, review: reviewId, drawings: [...drawings, drawing] };
  mkdirSync(dirOf(inboxDirPath), { recursive: true, mode: 0o700 });
  const path = fileOf(inboxDirPath, reviewId);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(file)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600); // `mode` applies only on create.
  renameSync(temp, path);
  return drawing;
}

/** Remove the drawings of every review whose message is gone (after a deletion). */
export function pruneInboxReviewDrawings(inboxDirPath: string, messageExists: (messageId: string) => boolean): void {
  let names: string[];
  try {
    names = readdirSync(dirOf(inboxDirPath));
  } catch {
    return;
  }
  for (const name of names) {
    const id = name.split(".", 1)[0]!;
    if (!isInboxId("msg", id) || messageExists(id)) continue;
    try {
      unlinkSync(join(dirOf(inboxDirPath), name));
    } catch {
      // Already gone.
    }
  }
}
