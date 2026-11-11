/**
 * A pull request's own pictures and videos for the Inbox window (owner, 2026-11-11: "Yes, inline"). The window never
 * loads a picture from the web (its CSP stays `img-src 'self' data: blob:`), so the Inbox fetches the file and the
 * browser talks only to the Inbox.
 *
 * Only GitHub's own uploads (`isGitHubAttachmentUrl`: the rule the review app's picture proxy uses), only one the
 * PR's own text names (description, comments, reviews, threads, as the details read answered it; the shared
 * `isPRArtifactDocumentUrlAllowed`), only for a PR the last list named, on github.com. Fetched with the person's own
 * `gh` sign-in by the review app's fetch (`fetchPRArtifactContent`: 64 MB, 15 s, Range passed through for seeking),
 * every redirect kept on GitHub's attachment hosts and their upload bucket (`isGitHubAttachmentRedirect`). Answered
 * only as a picture or a video. Nothing else is ever fetched, so this is no open proxy.
 *
 * GitLab is not served: its uploads are relative paths read through the uploads API with a token, and that path is not
 * proven here; a GitLab MR's pictures stay chips.
 */

import type { GithubPRMetadata } from "@plannotator/shared/pr-types";
import { fetchPRArtifactContent, PRArtifactDocumentError } from "@plannotator/shared/pr-artifact-document";
import { isGitHubAttachmentRedirect, isGitHubAttachmentUrl } from "@plannotator/core/pr-attachment-url";
import { InboxPullsError, type InboxPulls } from "./inbox-pulls";

/** The longest URL asked for: GitHub's attachment URLs are short. */
const MAX_URL_CHARS = 2048;

const refuse = (status: number, code: string, error: string): Response =>
  Response.json({ error, code }, { status, headers: { "cache-control": "no-store" } });

const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "video/mp4", "video/quicktime", "video/webm"]);

/** `GET /api/inbox/pulls/media?key=&url=`: one picture or video of the PR's own text. Guards run in the caller. */
export async function pullMediaResponse(pulls: Pick<InboxPulls, "text">, key: string, rawUrl: string, range: string | null): Promise<Response> {
  if (key.length === 0 || key.length > 600) return refuse(400, "validation_error", "key: a pull request's key from the list.");
  if (rawUrl.length === 0 || rawUrl.length > MAX_URL_CHARS || !isGitHubAttachmentUrl(rawUrl)) {
    return refuse(403, "media_not_allowed", "Only GitHub's own uploads in this pull request's text.");
  }
  let read: Awaited<ReturnType<InboxPulls["text"]>>;
  try {
    read = await pulls.text(key);
  } catch (cause) {
    if (cause instanceof InboxPullsError) {
      const status = cause.code === "pull_unknown" ? 404 : cause.code === "pull_details_held" ? 429 : 502;
      return refuse(status, cause.code, cause.message);
    }
    throw cause;
  }
  const { pull, context, runtime } = read;
  const [owner, repo] = pull.repo.split("/");
  if (pull.platform !== "github" || pull.host.toLowerCase() !== "github.com" || !owner || !repo) {
    return refuse(403, "media_not_allowed", "Only a pull request on github.com.");
  }
  const metadata: GithubPRMetadata = {
    platform: "github",
    host: pull.host,
    owner,
    repo,
    number: pull.number,
    title: pull.title,
    author: pull.author ?? "",
    baseBranch: pull.base,
    headBranch: pull.head,
    baseSha: "",
    headSha: pull.head_sha ?? "",
    url: pull.url,
  };
  try {
    const media = await fetchPRArtifactContent(runtime, metadata, context, rawUrl, {
      ...(range ? { range } : {}),
      // GitHub hands the bytes to its S3 bucket: follow only there, and never with the person's token.
      followRedirect: isGitHubAttachmentRedirect,
      authOnRequestedOriginOnly: true,
    });
    if (!MEDIA_TYPES.has(media.contentType.toLowerCase())) return refuse(415, "media_not_media", "Not a picture or a video.");
    return new Response(media.content, {
      status: media.status === 206 ? 206 : 200,
      headers: {
        "content-type": media.contentType,
        "cache-control": "private, max-age=300",
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox; default-src 'none'",
        "cross-origin-resource-policy": "same-origin",
        "accept-ranges": media.acceptRanges ?? "bytes",
        ...(media.contentRange ? { "content-range": media.contentRange } : {}),
      },
    });
  } catch (cause) {
    if (!(cause instanceof PRArtifactDocumentError)) throw cause;
    const code = cause.status === 403 ? "media_not_allowed" : cause.status === 413 ? "media_too_large" : cause.status === 504 ? "media_timeout" : cause.status === 401 ? "media_sign_in" : "media_failed";
    return refuse(cause.status === 401 || cause.status === 403 || cause.status === 413 || cause.status === 504 ? cause.status : 502, code, cause.message);
  }
}
