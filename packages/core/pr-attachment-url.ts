/**
 * The one rule for which pictures and videos in a pull request's text are
 * GitHub's own uploads: what the review app's picture proxy rewrites, and the
 * only URLs the Inbox's PR media route fetches. `github.com/user-attachments/`
 * (assets and files), and the older `user-images` / `private-user-images`
 * hosts. https only, no port, no user or password in the URL.
 */
export function isGitHubAttachmentUrl(raw: string | URL): boolean {
  let url: URL;
  try {
    url = typeof raw === 'string' ? new URL(raw) : raw;
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  return (url.hostname === 'github.com' && /^\/user-attachments\/(?:assets|files)\//.test(url.pathname))
    || url.hostname === 'user-images.githubusercontent.com'
    || url.hostname === 'private-user-images.githubusercontent.com';
}

/**
 * Where GitHub sends an attachment's bytes: `github.com/user-attachments/assets/<id>`
 * answers 302 to its upload bucket on S3 (signed for a few minutes), or to
 * `private-user-images` for a private repository. A fetch that follows a
 * redirect may land only on these or on another attachment URL.
 */
export function isGitHubAttachmentRedirect(url: URL): boolean {
  if (isGitHubAttachmentUrl(url)) return true;
  return url.protocol === 'https:'
    && !url.username && !url.password && !url.port
    && /^github-production-user-asset-[0-9a-z]+\.s3\.amazonaws\.com$/.test(url.hostname);
}
