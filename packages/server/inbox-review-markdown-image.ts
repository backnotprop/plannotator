/**
 * The pictures of a rendered Markdown file in code review's preview, in the
 * Inbox (review parity B3): one image a changed `.md` file shows, at one side
 * of the diff, for the review app's own `MarkdownFilePreview`, which the PR
 * page and guided reviews draw through `GuideReader`'s `images`.
 *
 *  - `GET /api/inbox/pulls/review-markdown-image?key&scope[&from]&doc&side&src&snapshot`:
 *    a pull request's diff at the head `snapshot` names (any other is stale,
 *    409); the picture is read at that head (the new side) or where the diff
 *    runs from (the old), from a clone on this computer or else the forge.
 *  - `GET /api/inbox/messages/:id/guide/review-markdown-image?doc&side&src&snapshot`:
 *    a guided review's patch (`snapshot` the message id). The document and a
 *    picture the patch changes are the blobs its `index` line names (as the
 *    image previews read them); a picture the patch does not change is read as
 *    committed at the commit the guide pins (the project's HEAD for a guide
 *    that records none), a git object, never the working tree.
 *
 * Every decision is the shared handler's (packages/shared/review-markdown-image.ts),
 * as in code review's `/api/review-markdown-image`: `doc` must be a Markdown file
 * the patch changes; `src` a relative image path that stays inside the
 * repository; the document's text at that side must show it as an image; then
 * the image answer of `/api/review-image` (caps, sniffed type, sandbox CSP).
 * The side readers are the image previews' own (inbox-review-image.ts), and so
 * are the checks made before anything is read. Bun only.
 */

import { handleReviewMarkdownImageRequest, REVIEW_MARKDOWN_IMAGE_SRC_MAX } from "@plannotator/shared/review-markdown-image";
import { reviewImageErrorResponse, type ReviewImageResponse } from "@plannotator/shared/review-image";
import { guideImageSource, isImageResponse, pullImageSource, refusedAsked, type GuideImageOptions, type PullImageOptions } from "./inbox-review-image";

/** What the request names, checked before anything is read: `doc` and `side` as an image's, and a `src` at all. */
function refusedMarkdownAsked(params: URLSearchParams): ReviewImageResponse | null {
  const refused = refusedAsked(params, "doc");
  if (refused) return refused;
  const src = params.get("src") ?? "";
  if (!src.trim() || src.length > REVIEW_MARKDOWN_IMAGE_SRC_MAX) {
    return reviewImageErrorResponse(400, { reason: "bad-request", error: "Expected doc, side=old|new, src and snapshot" });
  }
  return null;
}

/** One picture of a changed Markdown file in a pull request's diff. */
export async function pullReviewMarkdownImage(options: PullImageOptions): Promise<ReviewImageResponse> {
  const refused = refusedMarkdownAsked(options.params);
  if (refused) return refused;
  const source = await pullImageSource(options);
  if (isImageResponse(source)) return source;
  return handleReviewMarkdownImageRequest({ params: options.params, ifNoneMatch: options.ifNoneMatch ?? null, ...source, ...(options.signal ? { signal: options.signal } : {}) });
}

/** One picture of a changed Markdown file in a guided review's patch. */
export async function guideReviewMarkdownImage(options: GuideImageOptions): Promise<ReviewImageResponse> {
  const refused = refusedMarkdownAsked(options.params);
  if (refused) return refused;
  return handleReviewMarkdownImageRequest({ params: options.params, ifNoneMatch: options.ifNoneMatch ?? null, ...guideImageSource(options, "head"), ...(options.signal ? { signal: options.signal } : {}) });
}
