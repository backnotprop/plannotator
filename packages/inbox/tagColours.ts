/**
 * Tag row colours in the window (approval "inbox-thread-tags", build step 3; inbox-tag-colours.ts has the model). A
 * row in a tag that has a colour is tinted whole and names the tag ("C · The whole row, plus the tag's name"); one
 * colour per row, from its coloured tag first by name, the rest named in its tooltip. In
 * a tag's own list that tag steps aside (every row has it). "Show tag colors" off: no row and no sidebar tag is tinted.
 *
 * The row follows the pick (approval "inbox-tag-colors-picker"): tagColourMap.ts turns the colour into a row per
 * theme, its hue and part of its strength kept, its lightness held so the row's text keeps AA in every state. A stored
 * name (an earlier Inbox's preset) shows as the calm colour of its hue; accent as Indigo.
 */
import { INBOX_TAG_PRESET_HEX, inboxTagOwnColour, inboxTagShownHex, inboxTagSwatchName, INBOX_TAG_SWATCHES, isInboxTagPreset, type InboxTagPreset } from '@plannotator/core/inbox-types';
import { hexToOklch, tintLook } from './tagColourMap';

/** The list ⋮'s switch for every row colour (the owner asked for "show tag color"; the window writes "colors"). */
export const SHOW_TAG_COLOURS_LABEL = 'Show tag colors';

/** A stored name as the window says it: the hue it shows as (accent is drawn as Indigo). */
export const TAG_PRESET_NAMES: Record<InboxTagPreset, string> = { accent: 'Indigo', green: 'Green', amber: 'Amber', red: 'Red', grey: 'Grey' };

/** The twelve quick swatches, as the menu draws them. */
export const TAG_SWATCHES = INBOX_TAG_SWATCHES;

/** "Teal" (a quick swatch or a stored name), or "Custom" for an own colour: the tag menu's Highlight rows item says it. */
export function tagColourName(colour: string): string {
  return isInboxTagPreset(colour) ? TAG_PRESET_NAMES[colour] : (inboxTagSwatchName(colour) ?? 'Custom');
}

/** "Teal", or "Custom #ff6a00". */
export function tagColourLong(colour: string): string {
  const name = tagColourName(colour);
  return name === 'Custom' ? `Custom ${colour}` : name;
}

/** The colour menu's line: "Teal: rows tagged Release", or "Off: rows look as usual". */
export function tagColourCaption(colour: string | null, tagName: string): string {
  return colour ? `${tagColourLong(colour)}: rows tagged ${tagName}` : 'Off: rows look as usual';
}

/** The `#rrggbb` a stored colour shows as. */
export function tagShownHex(colour: string): string {
  return inboxTagShownHex(colour);
}

/** The person's own colours worth a swatch: codes that are not quick swatches (an older Inbox keeps those too). */
export function tagOwnRecent(recent: readonly string[]): string[] {
  return recent.filter((c) => inboxTagOwnColour(c));
}

/** The check's colour on a swatch of this colour: white on a deep one (OKLCH lightness under 0.7), else the dark ink. */
export function swatchInk(hex: string): string {
  return hexToOklch(hex).l < 0.7 ? '#ffffff' : '#11161f';
}

/** Each colour's attributes once worked out: every row of a tag draws the same. */
const drawn = new Map<string, { 'data-tint': string; style: Record<string, string> }>();

/**
 * How a colour is drawn: `data-tint` (a stored name, or `custom` for a code) and the row in both themes as custom
 * properties threadTags.css reads: `--ib-tint-ld` / `--ib-tint-dd` the lightness against the card, `--ib-tint-lc` /
 * `--ib-tint-dc` the chroma, `--ib-tint-hue`.
 */
export function tintAttrs(colour: string): { 'data-tint': string; style: Record<string, string> } {
  const kept = drawn.get(colour);
  if (kept) return kept;
  const look = tintLook(isInboxTagPreset(colour) ? INBOX_TAG_PRESET_HEX[colour] : colour);
  const attrs = {
    'data-tint': isInboxTagPreset(colour) ? colour : 'custom',
    style: {
      '--ib-tint-ld': String(look.light.delta),
      '--ib-tint-lc': String(look.light.c),
      '--ib-tint-dd': String(look.dark.delta),
      '--ib-tint-dc': String(look.dark.c),
      '--ib-tint-hue': String(look.h),
    },
  };
  if (drawn.size > 500) drawn.clear();
  drawn.set(colour, attrs);
  return attrs;
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
