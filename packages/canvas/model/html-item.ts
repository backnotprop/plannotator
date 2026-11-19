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
 * A face the HOST lends to HTML items, so an item can be set in the product's
 * own type. The policy lets fonts be `data:` only and nothing is fetched, so
 * the bytes travel inside the item's document: the host gives each face as a
 * `data:` URL and the package writes the `@font-face` rule, ahead of the
 * item's markup. An item's author only names a family in their own CSS. They
 * cannot add to this list, change a rule in it or give it an address.
 */
export interface HtmlItemFace {
  /** The name an item writes in `font-family`. Letters, digits, spaces, `-` and `_`; it starts with a letter. */
  family: string;
  /** The font's bytes: `data:font/woff2;base64,…` (also woff, ttf, otf). */
  src: string;
  /** One weight, or the two ends of a variable font's range. Absent: any weight is drawn with this file. */
  weight?: number | [number, number];
  style?: 'normal' | 'italic';
}

/** How much type a host may lend: the faces, the size of one (the length of its `data:` URL) and of all together. */
export const HTML_ITEM_FACE_LIMITS = { faces: 6, faceLength: 256_000, totalLength: 512_000 } as const;

const FAMILY_RE = /^[A-Za-z][A-Za-z0-9 _-]{0,47}$/;
/** A font as a `data:` URL: one of four font types, base64, and nothing but the base64 alphabet after the comma. */
const FONT_DATA_RE = /^data:(?:font\/(woff2|woff|ttf|otf)|application\/font-(woff2|woff)|application\/x-font-(ttf|otf|woff));base64,[A-Za-z0-9+/]+={0,2}$/;
const FONT_FORMATS: Record<string, string> = { woff2: 'woff2', woff: 'woff', ttf: 'truetype', otf: 'opentype' };

const isWeight = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1000;

/**
 * The faces of a host's list that may be lent, each rebuilt from its checked
 * fields. Anything that is not understood is left out, never guessed at: a
 * family that is not a plain name, an address that is not a font's bytes as
 * base64, a face over its size, a second face with a family, weight and
 * style already taken, and every face after the list or the total is full.
 */
export function checkHtmlItemFaces(input: unknown): HtmlItemFace[] {
  if (!Array.isArray(input)) return [];
  const out: HtmlItemFace[] = [];
  const taken = new Set<string>();
  let total = 0;
  for (let i = 0; i < input.length && i < 64 && out.length < HTML_ITEM_FACE_LIMITS.faces; i++) {
    const value: unknown = input[i];
    if (typeof value !== 'object' || value === null) continue;
    const { family, src, weight, style } = value as Record<string, unknown>;
    if (typeof family !== 'string' || !FAMILY_RE.test(family)) continue;
    if (typeof src !== 'string' || src.length > HTML_ITEM_FACE_LIMITS.faceLength || !FONT_DATA_RE.test(src)) continue;
    if (total + src.length > HTML_ITEM_FACE_LIMITS.totalLength) continue;
    const face: HtmlItemFace = { family: family.trim(), src };
    if (isWeight(weight)) face.weight = weight;
    else if (Array.isArray(weight) && weight.length === 2 && isWeight(weight[0]) && isWeight(weight[1]) && weight[0] <= weight[1]) face.weight = [weight[0], weight[1]];
    else if (weight !== undefined) continue;
    if (style === 'italic' || style === 'normal') face.style = style;
    else if (style !== undefined) continue;
    const key = `${face.family.toLowerCase()}|${String(face.weight ?? '')}|${face.style ?? ''}`;
    if (taken.has(key)) continue;
    taken.add(key);
    total += src.length;
    out.push(face);
  }
  return out;
}

/**
 * The `@font-face` rules for the faces this item names. A face the item's
 * markup never mentions is left out, so an item that does not ask pays
 * nothing. Every face goes through `checkHtmlItemFaces` again here: what is
 * written is only ever a plain name, a number and base64.
 */
export function htmlItemFaceCss(html: string, faces: readonly HtmlItemFace[] | null | undefined): string {
  if (!faces?.length) return '';
  const text = html.toLowerCase();
  let css = '';
  for (const face of checkHtmlItemFaces(faces)) {
    if (!text.includes(face.family.toLowerCase())) continue;
    const kind = FONT_DATA_RE.exec(face.src);
    const format = FONT_FORMATS[kind?.[1] ?? kind?.[2] ?? kind?.[3] ?? ''];
    const weight = face.weight === undefined ? '' : `font-weight:${Array.isArray(face.weight) ? face.weight.join(' ') : face.weight};`;
    css += `@font-face{font-family:"${face.family}";src:url(${face.src}) format("${format}");${weight}${face.style ? `font-style:${face.style};` : ''}font-display:block}`;
  }
  return css;
}

/**
 * The whole document the iframe shows. The policy is the first thing in the
 * head, before any of the item's own markup, so nothing the item says can
 * come ahead of it; a later policy can only narrow an earlier one. `scheme`
 * is the theme the item is drawn in; it must match the frame element's own
 * colour scheme, or the browser gives the frame an opaque backdrop. `faces`
 * is the host's lent type (`HtmlItemFace`): its rules sit in the head, in a
 * style block that is closed before the item's markup begins.
 */
export function htmlItemSrcdoc(html: string, scheme: 'light' | 'dark' | null = null, faces?: readonly HtmlItemFace[] | null): string {
  const body = html.length > HTML_ITEM_MAX_LENGTH ? '' : html;
  const lent = htmlItemFaceCss(body, faces);
  return (
    '<!doctype html><html><head>' +
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(HTML_ITEM_CSP)}">` +
    '<meta charset="utf-8">' +
    (lent ? `<style>${lent}</style>` : '') +
    '<style>html,body{margin:0;background:transparent;overflow:hidden}' +
    'body{font:14px/1.45 system-ui,sans-serif;color:CanvasText}' +
    `:root{color-scheme:${scheme ?? 'light dark'}}` +
    // More below than the item's box shows: its foot fades out, so the cut is not mistaken for the end. The
    // item runs no script, so this is asked of CSS: the fade is tied to there being something to scroll to.
    '@supports (animation-timeline:scroll()){html::after{content:"";position:fixed;left:0;right:0;bottom:0;height:28px;pointer-events:none;opacity:0;' +
    'background:linear-gradient(transparent,Canvas);animation:pcv-more linear both;animation-timeline:scroll(root block)}' +
    '@keyframes pcv-more{from{opacity:1}to{opacity:1}}}</style>' +
    `</head><body>${body}</body></html>`
  );
}

const IMAGE_DATA_RE = /^data:image\/(?:png|jpeg|gif|webp|avif|svg\+xml)[;,]/i;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Whether an address may be handed to an `<img>` (or a CSS background) once
 * a reference has been resolved: http(s), blob, an image `data:` URL, or a
 * path with no scheme. Never `javascript:` or another scheme. This is about
 * what the browser is asked to load; what a document may store is narrower
 * (`isPictureRef`).
 */
export function isSafeImageSrc(src: unknown): src is string {
  if (typeof src !== 'string' || src.length === 0 || src.length > 2_000_000) return false;
  const value = src.trim();
  if (IMAGE_DATA_RE.test(value)) return true;
  if (/^https?:\/\//i.test(value) || /^blob:/i.test(value)) return true;
  // A backslash is read as a slash by browsers, so `/\\host` would be another site, not a path.
  return !SCHEME_RE.test(value) && !value.startsWith('//') && !value.includes('\\');
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
