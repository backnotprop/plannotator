/**
 * Cheap content hash (djb2 xor variant) for diff-change detection. Replaces
 * patch-LENGTH proxies: a same-length different-content patch must still
 * remount the all-files list (fileSetKey) and must not collide in Pierre's
 * highlight / render caches (cacheKey). Not cryptographic — collision odds
 * for this purpose are fine.
 *
 * Shared by both review surfaces (AllFilesCodeView, DiffViewer) so their
 * cache keys are minted the same way.
 */
export function hashString(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash * 33) ^ value.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}
