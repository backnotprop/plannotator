/**
 * Pictures are stored by the host, not in the document.
 *
 * A document, an event and a plan's text never hold a picture's bytes (no
 * `data:` URL): one screenshot would make every envelope and every capture
 * megabytes. They hold a short reference instead, and the host keeps the
 * bytes behind an `AssetPort`:
 *
 * - `asset:<name>`: something the host stored. The name is the host's, and
 *   is best a content hash (`asset:sha256-9f2c…`), so the same picture pasted
 *   twice is stored once and a reference never goes stale. A store that
 *   already keeps attachments by SHA-256 implements the port in a few lines.
 * - an `http(s)` address, or a path with no scheme (the host resolves it).
 *
 * The same picture referenced by fifty snapshots costs fifty short strings.
 */

/** What a host tells the editor when it will not keep a picture. The editor shows a line for each. */
export type AssetRefusal = 'too-large' | 'not-a-picture' | 'failed';

export interface AssetPort {
  /** Keep these bytes. Answers with the reference to put in the document, or why not. */
  put(file: Blob, name?: string): Promise<{ ref: string } | { refused: AssetRefusal }>;
  /** An address the browser can load for a reference this port gave out. Null: not known here. */
  url(ref: string): string | null;
}

const ASSET_RE = /^asset:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

export const isAssetRef = (value: unknown): boolean => typeof value === 'string' && ASSET_RE.test(value);

/**
 * Whether a picture, sprite, card picture or icon address may be stored in a
 * document: an asset reference, http(s), or a path with no scheme. Never a
 * `data:` or `blob:` URL (bytes, or an address that dies with the page), and
 * never another scheme.
 */
export function isPictureRef(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  const src = value.trim();
  if (src !== value) return false;
  if (isAssetRef(src)) return true;
  if (/^https?:\/\/[^\s]+$/i.test(src)) return true;
  // A backslash is read as a slash by browsers, so `/\\host` would be another site, not a path.
  return !SCHEME_RE.test(src) && !src.startsWith('//') && !src.includes('\\') && !/\s/.test(src);
}

/**
 * The one function a view needs to turn a stored reference into something
 * loadable: asset references go to the port, anything else to the host's
 * own resolver (or stays as it is). An asset this port does not know gives
 * an empty address, and the view shows the picture's words instead.
 */
export function pictureResolver(assets?: AssetPort | null, other?: (src: string) => string): (src: string) => string {
  return (src) => {
    if (isAssetRef(src)) return assets?.url(src) ?? '';
    return other ? other(src) : src;
  };
}
