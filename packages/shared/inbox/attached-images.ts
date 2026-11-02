/**
 * Plannotator Inbox: pictures sent only as attachments (the owner,
 * 2026-11-02). An attached image shows as a tile at the bottom of the
 * message, away from the words about it, so the person scrolls down to find
 * what an option or a finding looks like. send_message's result then adds
 * one line of advice for the agent's next message. Advice only: the send
 * succeeds as it is, the person sees nothing different, and nothing more is
 * sent.
 */

import { basename, isAbsolute, resolve } from "node:path";
import { inboxMessageImageRefsInOrder } from "./message-images";

/** The image kinds the advice is about, by the name as the agent wrote it. */
const PICTURE_PATH_RE = /\.(png|jpe?g|gif|webp|svg)$/i;

/**
 * The attachments (as the agent wrote them) that are pictures the body does
 * not also show with `![alt](path)` or `<img src>`. A body image counts as
 * the attachment when both resolve to the same path, or, since the two may
 * resolve from different folders, when they have the same file name.
 *
 * `attachmentBase` is the folder relative attachments resolve from,
 * `bodyBase` the one relative body images resolve from (each may be null:
 * then a relative path is compared by file name only).
 */
export function attachedImagesNotInBody(
  body: string,
  attachments: readonly string[] | undefined,
  attachmentBase: string | null = null,
  bodyBase: string | null = attachmentBase,
): string[] {
  if (!attachments || attachments.length === 0) return [];
  const pictures = attachments.filter((path) => PICTURE_PATH_RE.test(path.trim()));
  if (pictures.length === 0) return [];
  const full = (path: string, base: string | null): string | null =>
    isAbsolute(path) ? resolve(path) : base ? resolve(base, path) : null;
  const shown = inboxMessageImageRefsInOrder(body);
  const shownPaths = new Set(shown.map((ref) => full(ref, bodyBase)).filter((path): path is string => path !== null));
  const shownNames = new Set(shown.map((ref) => basename(ref)));
  const out: string[] = [];
  for (const path of pictures) {
    const trimmed = path.trim();
    const resolved = full(trimmed, attachmentBase);
    if ((resolved && shownPaths.has(resolved)) || shownNames.has(basename(trimmed))) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/** The advice line for `count` such pictures, or "" for none. Starts with a space: appended to the result text. */
export function attachedImagesNotInBodyText(count: number): string {
  if (count <= 0) return "";
  return count === 1
    ? " 1 image is attached but not shown in the text: next time put it where you write about it with `![alt](path)`."
    : ` ${count} images are attached but not shown in the text: next time put each where you write about it with \`![alt](path)\`.`;
}
