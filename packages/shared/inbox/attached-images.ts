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
import { isReviewImagePath } from "../diff-paths";
import { inboxMessageImageRefsInOrder, pathCandidates } from "./message-images";

/** The bases a relative path may resolve from, without the missing ones and without repeats. */
function basesOf(...bases: (string | null)[]): string[] {
  return [...new Set(bases.filter((base): base is string => !!base))];
}

/**
 * The attachments (as the agent wrote them) that are pictures (an image the
 * window shows: png, jpg, gif, webp, svg, avif, bmp, ico, apng) the body does
 * not also show with `![alt](path)` or `<img src>`.
 *
 * A body image counts as the attachment when it names the same file in any
 * form the window tries (`pathCandidates`: as written, without a `?query` or
 * `#fragment`, percent-decoded), compared without case where the file system
 * ignores it (macOS, Windows). A relative path resolves from either base
 * (`attachmentBase`, where relative attachments start, and `bodyBase`, where
 * relative body images start), since the two may differ for one file. Only
 * when a side has no base to resolve from is the bare file name compared:
 * two attachments with one name in different folders stay apart.
 */
export function attachedImagesNotInBody(
  body: string,
  attachments: readonly string[] | undefined,
  attachmentBase: string | null = null,
  bodyBase: string | null = attachmentBase,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (!attachments || attachments.length === 0) return [];
  const pictures = attachments.map((path) => path.trim()).filter((path) => isReviewImagePath(path));
  if (pictures.length === 0) return [];
  const fold = platform === "darwin" || platform === "win32" ? (path: string) => path.toLowerCase() : (path: string) => path;
  const bases = basesOf(attachmentBase, bodyBase);
  /** Every absolute path a src may mean, or null when it is relative and nothing resolves it. */
  const fullPaths = (src: string): string[] | null => {
    if (isAbsolute(src)) return [fold(resolve(src))];
    return bases.length > 0 ? bases.map((base) => fold(resolve(base, src))) : null;
  };
  const shownPaths = new Set<string>();
  const unresolvedNames = new Set<string>();
  for (const ref of inboxMessageImageRefsInOrder(body)) {
    for (const candidate of pathCandidates(ref)) {
      const full = fullPaths(candidate);
      if (full) for (const path of full) shownPaths.add(path);
      else unresolvedNames.add(fold(basename(candidate)));
    }
  }
  const shownNames = new Set([...shownPaths].map((path) => basename(path)));
  const out: string[] = [];
  for (const path of pictures) {
    const full = fullPaths(path);
    const shown = full
      ? full.some((candidate) => shownPaths.has(candidate)) || unresolvedNames.has(fold(basename(path)))
      : shownNames.has(fold(basename(path))) || unresolvedNames.has(fold(basename(path)));
    if (!shown && !out.includes(path)) out.push(path);
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
