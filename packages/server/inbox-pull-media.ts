import type { GithubPRMetadata } from "@plannotator/shared/pr-types";
import { fetchPRArtifactContent, PRArtifactDocumentError } from "@plannotator/shared/pr-artifact-document";
import { isGitHubAttachmentRedirect, isGitHubAttachmentUrl } from "@plannotator/core/pr-attachment-url";
import { readImageDimensions } from "@plannotator/shared/review-image";
import type { InboxPull } from "@plannotator/core/inbox-types";
import { InboxPullsError, type InboxPulls } from "./inbox-pulls";

type PullText = Awaited<ReturnType<InboxPulls["text"]>>;

const MAX_URL_CHARS = 2048;

const refuse = (status: number, code: string, error: string): Response =>
  Response.json({ error, code }, { status, headers: { "cache-control": "no-store" } });

const MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "video/mp4", "video/quicktime", "video/webm"]);

function githubMetadata(pull: InboxPull): GithubPRMetadata | null {
  const [owner, repo] = pull.repo.split("/");
  if (pull.platform !== "github" || pull.host.toLowerCase() !== "github.com" || !owner || !repo) return null;
  return {
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
}

function fetchMedia(read: PullText, metadata: GithubPRMetadata, rawUrl: string, range: string | null) {
  return fetchPRArtifactContent(read.runtime, metadata, read.context, rawUrl, {
    ...(range ? { range } : {}),
    // GitHub hands the bytes to its S3 bucket: follow only there, and never with the person's token.
    followRedirect: isGitHubAttachmentRedirect,
    authOnRequestedOriginOnly: true,
  });
}

export async function pullMediaResponse(pulls: Pick<InboxPulls, "text">, key: string, rawUrl: string, range: string | null): Promise<Response> {
  if (key.length === 0 || key.length > 600) return refuse(400, "validation_error", "key: a pull request's key from the list.");
  if (rawUrl.length === 0 || rawUrl.length > MAX_URL_CHARS || !isGitHubAttachmentUrl(rawUrl)) {
    return refuse(403, "media_not_allowed", "Only GitHub's own uploads in this pull request's text.");
  }
  let read: PullText;
  try {
    read = await pulls.text(key);
  } catch (cause) {
    if (cause instanceof InboxPullsError) {
      const status = cause.code === "pull_unknown" ? 404 : cause.code === "pull_details_held" ? 429 : 502;
      return refuse(status, cause.code, cause.message);
    }
    throw cause;
  }
  const metadata = githubMetadata(read.pull);
  if (!metadata) return refuse(403, "media_not_allowed", "Only a pull request on github.com.");
  try {
    const media = await fetchMedia(read, metadata, rawUrl, range);
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

const SIZE_READ_BYTES = 65_536;
const SIZES_MAX = 24;
const sizeCache = new Map<string, { width: number; height: number } | null>();

/** Every GitHub upload a markdown or HTML image in the text names. */
function pictureUrls(markdown: string): string[] {
  const found = [...markdown.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)/g), ...markdown.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!.replace(/&amp;/g, "&"));
  return found.filter((url) => url.length <= MAX_URL_CHARS && isGitHubAttachmentUrl(url));
}

// The window reserves each picture's box before its bytes arrive (slow links), so the text never jumps.
export async function pullMediaSizesResponse(pulls: Pick<InboxPulls, "text">, key: string): Promise<Response> {
  if (key.length === 0 || key.length > 600) return refuse(400, "validation_error", "key: a pull request's key from the list.");
  let read: PullText;
  try {
    read = await pulls.text(key);
  } catch (cause) {
    if (cause instanceof InboxPullsError) return refuse(cause.code === "pull_unknown" ? 404 : 502, cause.code, cause.message);
    throw cause;
  }
  const metadata = githubMetadata(read.pull);
  if (!metadata) return Response.json({ sizes: {} });
  const { context } = read;
  const texts = [context.body, ...context.comments.map((c) => c.body), ...context.reviews.map((r) => r.body), ...context.reviewThreads.flatMap((t) => t.comments.map((c) => c.body))];
  const urls = [...new Set(texts.flatMap(pictureUrls))].slice(0, SIZES_MAX);
  const sizes: Record<string, { width: number; height: number }> = {};
  const queue = [...urls];
  const worker = async () => {
    for (let url = queue.shift(); url; url = queue.shift()) {
      if (!sizeCache.has(url)) {
        try {
          const head = await fetchMedia(read, metadata, url, `bytes=0-${SIZE_READ_BYTES - 1}`);
          const type = head.contentType.toLowerCase();
          sizeCache.set(url, MEDIA_TYPES.has(type) && type.startsWith("image/") ? readImageDimensions(head.content, type) : null);
        } catch {
          continue;
        }
        if (sizeCache.size > 500) sizeCache.delete(sizeCache.keys().next().value!);
      }
      const size = sizeCache.get(url);
      if (size && size.width > 0 && size.height > 0) sizes[url] = size;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return Response.json({ sizes }, { headers: { "cache-control": "private, max-age=300" } });
}
