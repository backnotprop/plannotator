/**
 * Tag row colours in the window (approval "inbox-thread-tags", build step 3; inbox-tag-colours.ts has the model). A
 * row in a tag that has a colour is tinted whole and names the tag ("C · The whole row, plus the tag's name"); one
 * colour per row, from its coloured tag first by name, the rest named in its tooltip. In
 * a tag's own list that tag steps aside (every row has it). "Show tag colors" off: no row and no sidebar tag is tinted.
 *
 * A preset is a theme token (threadTags.css), so each palette and mode gives its own. A person's own colour keeps
 * only its hue and, within 0.08 to 0.18, its chroma (OKLCH); the window sets the lightness, 0.52 in light and 0.72
 * in dark, the band of the theme's own green, amber and red, so no pick can make a row's text hard to read. Below
 * 0.03 chroma (black, white, greys) there is no hue to keep and it tints as Grey does.
 */
import { INBOX_TAG_PRESETS, isInboxTagPreset, type InboxTagPreset } from '@plannotator/core/inbox-types';

/** The list ⋮'s switch for every row colour (the owner asked for "show tag color"; the window writes "colors"). */
export const SHOW_TAG_COLOURS_LABEL = 'Show tag colors';

export const TAG_PRESET_NAMES: Record<InboxTagPreset, string> = { accent: 'Accent', green: 'Green', amber: 'Amber', red: 'Red', grey: 'Grey' };

export const TAG_PRESETS: readonly { id: InboxTagPreset; name: string }[] = INBOX_TAG_PRESETS.map((id) => ({ id, name: TAG_PRESET_NAMES[id] }));

/** "Green", or "Custom" for an own colour: the tag menu's Highlight rows item says it. */
export function tagColourName(colour: string): string {
  return isInboxTagPreset(colour) ? TAG_PRESET_NAMES[colour] : 'Custom';
}

/** "Green", or "Custom #ff6a00". */
export function tagColourLong(colour: string): string {
  return isInboxTagPreset(colour) ? TAG_PRESET_NAMES[colour] : `Custom ${colour}`;
}

/** The colour menu's line: "Green: rows tagged Release", or "Off: rows look as usual". */
export function tagColourCaption(colour: string | null, tagName: string): string {
  return colour ? `${tagColourLong(colour)}: rows tagged ${tagName}` : 'Off: rows look as usual';
}

function toLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** `#rrggbb` in OKLCH (lightness 0 to 1, chroma, hue in degrees). */
export function hexToOklch(hex: string): { l: number; c: number; h: number } {
  const n = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => toLinear(parseInt(n.slice(i, i + 2), 16) / 255)) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

/** An OKLCH colour as `#rrggbb`, clipped into sRGB. */
export function oklchToHex(L: number, C: number, H: number): string {
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return `#${rgb
    .map((v) => {
      const c = Math.max(0, Math.min(1, v));
      const e = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
      return Math.round(e * 255)
        .toString(16)
        .padStart(2, '0');
    })
    .join('')}`;
}

export const OWN_LIGHT_L = 0.52;
export const OWN_DARK_L = 0.72;
/** The hex a place on the hue strip writes: mid lightness, inside the kept chroma band. */
const STRIP_HEX_L = 0.62;
const STRIP_HEX_C = 0.15;

/** An own colour's two theme colours (CSS `oklch()`), or null for one with no hue (it tints as Grey). */
export function ownColour(hex: string): { light: string; dark: string; hue: number } | null {
  const { c, h } = hexToOklch(hex);
  if (c < 0.03) return null;
  const chroma = Math.min(0.18, Math.max(0.08, c)).toFixed(3);
  const hue = h.toFixed(1);
  return { light: `oklch(${OWN_LIGHT_L} ${chroma} ${hue})`, dark: `oklch(${OWN_DARK_L} ${chroma} ${hue})`, hue: Math.round(h) % 360 };
}

/** The hex a place on the hue strip stands for. */
export function hueHex(hue: number): string {
  return oklchToHex(STRIP_HEX_L, STRIP_HEX_C, hue);
}

/** How a colour is drawn: `data-tint` (a preset's name, or `custom`) and, for an own colour, its two theme colours. */
export function tintAttrs(colour: string): { 'data-tint': string; style?: Record<string, string> } {
  if (isInboxTagPreset(colour)) return { 'data-tint': colour };
  const own = ownColour(colour);
  if (!own) return { 'data-tint': 'grey' };
  return { 'data-tint': 'custom', style: { '--ib-tint-l': own.light, '--ib-tint-d': own.dark } };
}

/** A row's colour: the tag it comes from, the other coloured tags the row is in, and the colour. */
export interface RowTint {
  colour: string;
  name: string;
  /** The other coloured tags' names, by name. */
  also: readonly string[];
}

/**
 * The colour a row with these tags gets (`ids`), from `tags` with each one's colour (`colourOf`), or
 * null: none of its tags has a colour, or the only ones are the tag whose list this is (`listed`).
 */
export function rowTint(ids: readonly string[], tags: readonly { id: string; name: string }[], colourOf: (id: string) => string | null, listed: string | null): RowTint | null {
  if (ids.length === 0) return null;
  // By name, not by the sidebar's order: that order differs between machines, and a row must lead with the same tag on each.
  const coloured = tags
    .filter((tag) => tag.id !== listed && ids.includes(tag.id) && colourOf(tag.id) !== null)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const first = coloured[0];
  if (!first) return null;
  return { colour: colourOf(first.id)!, name: first.name, also: coloured.slice(1).map((tag) => tag.name) };
}

/** The tinted row's tooltip: "Highlighted: Release, Green. Also in Windows". */
export function rowTintTitle(tint: Pick<RowTint, 'colour' | 'name' | 'also'>): string {
  return `Highlighted: ${tint.name}, ${tagColourLong(tint.colour)}${tint.also.length > 0 ? `. Also in ${tint.also.join(', ')}` : ''}`;
}
