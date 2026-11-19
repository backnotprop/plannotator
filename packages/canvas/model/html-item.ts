/**
 * The sandbox contract for custom HTML items.
 *
 * An agent can put its own HTML on the canvas. That HTML is untrusted: it is
 * drawn only in an `<iframe>` built from the three exports below, and nothing
 * in this package may draw it any other way (no `innerHTML`, no
 * `dangerouslySetInnerHTML`, no shadow root).
 *
 * What the contract promises, and what gives it:
 * - No script runs. `sandbox=""` carries no `allow-scripts`, and the policy's
 *   `default-src 'none'` covers script too.
 * - No network. The policy lets styles be inline only and pictures and fonts
 *   be `data:` only, so nothing is fetched: no remote image, font, stylesheet
 *   or `@import`. With no `allow-scripts` the frame also cannot refresh
 *   itself to another address (`<meta http-equiv="refresh">` is one of the
 *   automatic features a sandbox turns off).
 * - No navigation of the page around it: no `allow-top-navigation`, no
 *   `allow-popups`, no `allow-forms`, and the frame takes no pointer or key
 *   (`HTML_ITEM_FRAME_ATTRS.inert`), so a link in it cannot be followed.
 * - No access to the page: with no `allow-same-origin` the frame has an
 *   origin of its own, so it reads no cookie, storage or DOM of ours.
 * - A transparent background, so the item sits on the board like any other.
 *
 * Do not add a sandbox token or loosen the policy to make an item work. A
 * scripted item is a product decision with its own review: it would add
 * `allow-scripts` alone, keep this policy with `script-src 'unsafe-inline'`,
 * and must then answer for `location` and refresh, which scripts bring back.
 */

/** The largest HTML one item may hold, in UTF-16 units. */
export const HTML_ITEM_MAX_LENGTH = 64_000;

/** Tokens for the iframe's `sandbox` attribute: none at all. */
export const HTML_ITEM_SANDBOX = '';

export const HTML_ITEM_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

/** Attributes every HTML item's iframe carries besides `sandbox` and `srcdoc`. */
export const HTML_ITEM_FRAME_ATTRS = {
  referrerPolicy: 'no-referrer',
  loading: 'lazy',
  inert: true,
  tabIndex: -1,
} as const;

const escapeAttr = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/**
 * The whole document the iframe shows. The policy is the first thing in the
 * head, before any of the item's own markup, so nothing the item says can
 * come ahead of it; a later policy can only narrow an earlier one.
 */
export function htmlItemSrcdoc(html: string): string {
  const body = html.length > HTML_ITEM_MAX_LENGTH ? '' : html;
  return (
    '<!doctype html><html><head>' +
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(HTML_ITEM_CSP)}">` +
    '<meta charset="utf-8">' +
    '<style>html,body{margin:0;background:transparent;overflow:hidden}' +
    'body{font:14px/1.45 system-ui,sans-serif;color:CanvasText}' +
    ':root{color-scheme:light dark}</style>' +
    `</head><body>${body}</body></html>`
  );
}

const IMAGE_DATA_RE = /^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml)[;,]/i;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Whether a picture or sprite address may be handed to an `<img>` (or a CSS
 * background): http(s), blob, an image `data:` URL, or a path with no scheme
 * (the host resolves it). Never `javascript:` or another scheme. A picture
 * element runs nothing, so any web picture is fine to show.
 */
export function isSafeImageSrc(src: unknown): src is string {
  if (typeof src !== 'string' || src.length === 0 || src.length > 2_000_000) return false;
  const value = src.trim();
  if (IMAGE_DATA_RE.test(value)) return true;
  if (/^https?:\/\//i.test(value) || /^blob:/i.test(value)) return true;
  return !SCHEME_RE.test(value) && !value.startsWith('//');
}

/** A web address a reference card may point at: http or https, nothing else. */
export function isWebUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname;
  } catch {
    return false;
  }
}
