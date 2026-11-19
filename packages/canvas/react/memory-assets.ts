/**
 * An `AssetPort` that keeps pictures in the page's memory, named by the
 * SHA-256 of their bytes. For the demo and for tests: nothing survives a
 * reload. A product host stores the bytes itself and implements the same
 * two functions.
 */
import type { AssetPort } from '../model/assets';

export function createMemoryAssets(options: { maxBytes?: number } = {}): AssetPort & { size(): number } {
  const urls = new Map<string, string>();
  return {
    async put(file) {
      if (options.maxBytes !== undefined && file.size > options.maxBytes) return { refused: 'too-large' };
      const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      const ref = `asset:sha256-${hex}`;
      if (!urls.has(ref)) urls.set(ref, URL.createObjectURL(file));
      return { ref };
    },
    url: (ref) => urls.get(ref) ?? null,
    size: () => urls.size,
  };
}
