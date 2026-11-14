/** GitHub's own PR uploads: the review app's picture proxy and the Inbox's PR media route both use this one rule. */
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

/** `user-attachments` answers 302 to GitHub's S3 upload bucket, so a redirect may land there too. */
export function isGitHubAttachmentRedirect(url: URL): boolean {
  if (isGitHubAttachmentUrl(url)) return true;
  return url.protocol === 'https:'
    && !url.username && !url.password && !url.port
    && /^github-production-user-asset-[0-9a-z]+\.s3\.amazonaws\.com$/.test(url.hostname);
}
