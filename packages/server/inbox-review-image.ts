/**
 * The image preview of code review, in the Inbox (review parity B2): one side
 * of a changed image as bytes, for the review app's own `ImageDiffPreview`,
 * which the PR page and guided reviews draw through `GuideReader`'s `images`.
 *
 *  - `GET /api/inbox/pulls/review-image?key&scope[&from]&path&side&snapshot`:
 *    a pull request's diff; `snapshot` is the head commit the patch on screen
 *    was read at (any other is stale, 409). The new side is read at that head,
 *    the old where the diff runs from, from a clone of the repository on this
 *    computer or else the forge (`InboxPulls.fileBytes`).
 *  - `GET /api/inbox/messages/:id/guide/review-image?path&side&snapshot`: a
 *    guided review's patch, as the agent sent it; `snapshot` is the message id.
 *    Each side is the blob the patch's `index` line names, from the project's
 *    git, or the working tree for the new side when its bytes are that blob,
 *    or (a guide of a pull request) the forge.
 *
 * Every decision is the shared handler's (packages/shared/review-image.ts), as
 * in code review's servers: only a file the patch changes, with no hunks and
 * an image extension (or an SVG); the byte and pixel caps; the content type
 * from the bytes, never the name; the sandboxed response headers. This module
 * only says where a side's bytes come from. Bun only: the Inbox has no Pi
 * server. The routes' guards (GET, same origin, Code review on for a PR) are
 * inbox.ts's, as for their neighbours.
 */

import { parseDiffToFiles } from "@plannotator/core/diff-files";
import { createConcurrencyLimiter, handleReviewImageRequest, REVIEW_IMAGE_READ_CONCURRENCY, reviewImageErrorResponse, type ReviewImageResponse } from "@plannotator/shared/review-image";
import { readDiffSideBytes, readGitObjectBytes, validateFilePath, type DiffSide, type FileBytesRead } from "@plannotator/shared/review-core";
import type { InboxPullDiffScope } from "@plannotator/core/inbox-types";
import { runtime as gitRuntime } from "./git";
import { gitBlobId, InboxPullsError, type InboxPulls } from "./inbox-pulls";

/** As code review's servers: at most this many side reads at once (git spawns, forge calls). */
const runImageRead = createConcurrencyLimiter(REVIEW_IMAGE_READ_CONCURRENCY);

/** The shared handler's answer as a Response. */
export function reviewImageHttp(result: ReviewImageResponse): Response {
  return new Response(result.body as BodyInit | null, { status: result.status, headers: result.headers });
}

/** A side reader's answer for a forge holding its reads, or a PR gone from the list: the handler's 502. */
function forgeRefusal(cause: unknown): never {
  if (cause instanceof InboxPullsError) throw new Error(cause.message);
  throw cause;
}

/**
 * The shared handler's answer for a request whose `path` or `side` is no use, before the diff it names is read; null
 * for one worth reading the diff for. The handler checks both again, after the diff.
 */
export function refusedAsked(params: URLSearchParams, pathParam = "path"): ReviewImageResponse | null {
  const path = params.get(pathParam);
  const side = params.get("side");
  if (!path || (side !== "old" && side !== "new") || !params.get("snapshot")) {
    return reviewImageErrorResponse(400, { reason: "bad-request", error: `Expected ${pathParam}, side=old|new and snapshot` });
  }
  try {
    validateFilePath(path);
  } catch {
    return reviewImageErrorResponse(404, { reason: "not-in-diff", error: "Invalid file path" });
  }
  return null;
}

/** Where a request's sides come from: the patch it is checked against, its snapshot rule and its side reader. */
export interface ImageSource {
  available: boolean;
  patch: string;
  isCurrentSnapshot: (snapshot: string) => boolean;
  readSide: (side: DiffSide, filePath: string, oldPath: string | undefined, maxBytes: number, signal?: AbortSignal) => Promise<FileBytesRead>;
}

export interface PullImageOptions {
  pulls: Pick<InboxPulls, "diff" | "fileBytes">;
  key: string;
  scope: InboxPullDiffScope;
  from?: string;
  params: URLSearchParams;
  /** The clones of the PR's repository on this computer (inbox.ts `pullRoots`). */
  roots: () => Promise<string[]>;
  ifNoneMatch?: string | null;
  signal?: AbortSignal;
}

/**
 * A pull request's diff in `scope`, read at the head the request's `snapshot` names, and its reader: any path of the
 * repository at that head (the new side) or where the diff runs from (the old), never anything else. The caller has
 * checked what the request names first (`refusedAsked`); an answer here is the forge's refusal.
 */
export async function pullImageSource(options: PullImageOptions): Promise<ImageSource | ReviewImageResponse> {
  const { pulls, key, scope, from, params } = options;
  const asked = params.get("snapshot") ?? "";
  const pinned = /^[0-9a-f]{40,64}$/.test(asked) ? asked : null;
  // The diff on screen, read at the head the window names (the PR page's `/pulls/diff` read it a moment ago).
  let answer: { patch: string; head_sha?: string | null } | null = null;
  if (pinned) {
    try {
      answer = await pulls.diff(key, scope, from, pinned);
    } catch (cause) {
      if (!(cause instanceof InboxPullsError)) throw cause;
      return { status: cause.code === "pull_unknown" ? 404 : 502, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }, body: JSON.stringify({ reason: "unavailable", error: cause.message, code: cause.code }) };
    }
  }
  let roots: Promise<string[]> | null = null;
  return {
    available: true,
    patch: answer?.patch ?? "",
    isCurrentSnapshot: (snapshot) => !!answer?.head_sha && snapshot === answer.head_sha,
    readSide: (side, filePath, oldPath, maxBytes, signal) =>
      runImageRead(async () => {
        roots ??= options.roots();
        return pulls.fileBytes(key, scope, side, filePath, oldPath, await roots, maxBytes, from, answer!.head_sha!).catch(forgeRefusal);
      }, signal),
  };
}

export const isImageResponse = (value: ImageSource | ReviewImageResponse): value is ReviewImageResponse => "status" in value;

/** One side of a changed image in a pull request's diff (`/api/inbox/pulls/review-image`). */
export async function pullReviewImage(options: PullImageOptions): Promise<ReviewImageResponse> {
  // What the request names is checked before anything is read: a bad path or side never reads the diff (or the forge).
  const refused = refusedAsked(options.params);
  if (refused) return refused;
  const source = await pullImageSource(options);
  if (isImageResponse(source)) return source;
  return handleReviewImageRequest({ params: options.params, ifNoneMatch: options.ifNoneMatch ?? null, ...source, ...(options.signal ? { signal: options.signal } : {}) });
}

/** The two blob ids a file's patch names (its `index` line), each null where that side does not exist. */
function indexIds(patch: string): { old: string | null; new: string | null } | null {
  const ids = /^index ([0-9a-f]{7,64})\.\.([0-9a-f]{7,64})/m.exec(patch);
  if (!ids) return null;
  const side = (id: string) => (/^0+$/.test(id) ? null : id);
  return { old: side(ids[1]!), new: side(ids[2]!) };
}

const insideRepository = (name: string) => {
  try {
    validateFilePath(name);
    return true;
  } catch {
    return false;
  }
};

/** A pure rename (`similarity index 100%`): both sides are the same bytes, under either name. */
const pureRename = (patch: string, oldPath: string | undefined, filePath: string): oldPath is string =>
  !!oldPath && oldPath !== filePath && /^similarity index 100%$/m.test(patch);

export interface GuideImageOptions {
  /** The guide's patch, as the agent sent it (null when its snapshot is gone from the store). */
  patch: string | null;
  /** The message the guide is on: the request's `snapshot`. */
  messageId: string;
  /** The project's folder on this computer, or null. */
  root: string | null;
  /** The commit the guide pins (`guideReviewOf`: a commit guide's commit, else its source's `headSha`), or null when it records none. */
  revision?: string | null;
  params: URLSearchParams;
  /** A guide of a pull request with Code review on: that PR's own side read (`InboxPulls.fileBytes`), else absent. */
  forge?: (side: DiffSide, filePath: string, oldPath: string | undefined, maxBytes: number) => Promise<FileBytesRead>;
  ifNoneMatch?: string | null;
  signal?: AbortSignal;
}

/**
 * A guided review's patch and its reader. The guide keeps the diff as sent while the working tree moves on, so a side
 * of a file the patch changes is only ever the blob its `index` line names. A pure rename names none: its bytes are
 * the file at the commit the guide pins (`revision`), under the side's own name or else the other one (a rename not
 * yet committed has only the old name there). Any other file whose patch names no blob (a patch rebuilt without them)
 * reads from `forge` alone. `unchanged`: how a path the patch does not change
 * is read (a Markdown file's picture): `"head"`, as committed at the guide's own revision (`revision`), a git object
 * (never the working tree, never the forge); absent, it is missing.
 */
export function guideImageSource(options: GuideImageOptions, unchanged?: "head"): ImageSource {
  const { patch, root } = options;
  let files: ReturnType<typeof parseDiffToFiles> | null = null;
  return {
    available: patch !== null,
    patch: patch ?? "",
    isCurrentSnapshot: (snapshot) => snapshot === options.messageId,
    readSide: (side, filePath, oldPath, maxBytes, signal) =>
      runImageRead(async (): Promise<FileBytesRead> => {
        files ??= parseDiffToFiles(patch ?? "");
        const file = files.find((f) => f.path === filePath);
        if (!file && unchanged === "head") {
          validateFilePath(filePath);
          // A guide that records no revision (a producer that names none) is read at the project's HEAD now: the best
          // there is, though the project may have moved on since the guide was made.
          const at = options.revision ?? "HEAD";
          return root ? readGitObjectBytes(gitRuntime, `${at}:${filePath}`, maxBytes, root) : { kind: "missing" };
        }
        const ids = file ? indexIds(file.patch) : null;
        const id = ids?.[side] ?? null;
        if (root && id) {
          const stored = await readGitObjectBytes(gitRuntime, id, maxBytes, root);
          if (stored.kind === "ok" || stored.kind === "too-large") return stored;
          // Uncommitted edits name a blob git never stored: the working tree's file, while it is still those bytes.
          if (side === "new") {
            // Only bytes that hash to the patch's blob say anything: a file past the cap cannot be hashed, so it is
            // "missing", never "too large" (that would tell the size of whatever sits at a path the patch names).
            const tree = await readDiffSideBytes(gitRuntime, { kind: "worktree", path: filePath }, maxBytes, root);
            if (tree.kind === "ok" && gitBlobId(tree.bytes).startsWith(id)) return tree;
          }
        }
        const pinned = options.revision && /^[0-9a-f]{40,64}$/.test(options.revision) ? options.revision : null;
        if (root && pinned && !ids && file && pureRename(file.patch, oldPath, filePath)) {
          for (const name of side === "old" ? [oldPath, filePath] : [filePath, oldPath]) {
            if (!insideRepository(name)) continue;
            const named = await readGitObjectBytes(gitRuntime, `${pinned}:${name}`, maxBytes, root);
            if (named.kind === "ok" || named.kind === "too-large") return named;
          }
        }
        if (!options.forge) return { kind: "missing" };
        // The PR may have moved on since the guide was sent: its side only while it is still the blob the patch names.
        const far = await options.forge(side, filePath, oldPath, maxBytes).catch(forgeRefusal);
        return far.kind !== "ok" || !id || gitBlobId(far.bytes).startsWith(id) ? far : { kind: "missing" };
      }, signal),
  };
}

/** One side of a changed image in a guided review's patch (`/api/inbox/messages/:id/guide/review-image`). */
export async function guideReviewImage(options: GuideImageOptions): Promise<ReviewImageResponse> {
  const refused = refusedAsked(options.params);
  if (refused) return refused;
  return handleReviewImageRequest({ params: options.params, ifNoneMatch: options.ifNoneMatch ?? null, ...guideImageSource(options), ...(options.signal ? { signal: options.signal } : {}) });
}
