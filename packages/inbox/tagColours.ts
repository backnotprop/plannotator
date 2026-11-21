/**
 * Tag row colours in the window (approval "inbox-thread-tags", build step 3; inbox-tag-colours.ts has the model). A
 * row in a tag that has a colour is tinted whole and names the tag ("C · The whole row, plus the tag's name"); one
 * colour per row, from its coloured tag first by name, the rest named in its tooltip. In
 * a tag's own list that tag steps aside (every row has it). "Show tag colors" off: no row and no sidebar tag is tinted.
 *
 * The row follows the pick (approval "inbox-tag-colors-picker"): tagTintTheme.ts turns the colour into the row's four
 * fills on the theme on screen, its hue and part of its strength kept, its lightness held so the row's text is never
 * harder to read than on that theme's plain row (and keeps 4.5:1 where the plain row does). A stored name (an earlier
 * Inbox's preset) shows as the calm colour of its hue; accent as Indigo.
 */
import { inboxTagOwnColour, inboxTagShownHex, inboxTagSwatchName, INBOX_TAG_SWATCHES, isInboxTagPreset, type InboxTagPreset } from '@plannotator/core/inbox-types';
import { hexToOklch } from './tagColourMap';
import { drawTint } from './tagTintSheet';

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

/**
 * How a colour is drawn: `data-tint` carries the stored value (a code, or an earlier Inbox's name), and tagTintSheet.ts
 * holds that value's four fills for the theme on screen (`--ib-tint-0` to `-3`, threadTags.css reads them).
 */
export function tintAttrs(colour: string): { 'data-tint': string } {
  drawTint(colour, inboxTagShownHex(colour));
  return { 'data-tint': colour };
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
