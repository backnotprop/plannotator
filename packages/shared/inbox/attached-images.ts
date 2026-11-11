/** Advice only: pictures attached but not shown in the body get one line in send_message's result; the send itself is unchanged. */

import { basename, isAbsolute, resolve } from "node:path";
import { isReviewImagePath } from "../diff-paths";
import { inboxMessageImageRefsInOrder, pathCandidates } from "./message-images";

function basesOf(...bases: (string | null)[]): string[] {
  return [...new Set(bases.filter((base): base is string => !!base))];
}

/** A body image matches an attachment when it names the same file in any form the window tries, compared without case where the file system ignores it. Relative paths resolve from either base. */
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
