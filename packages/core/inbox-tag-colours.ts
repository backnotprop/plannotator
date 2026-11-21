/**
 * A tag's row colour (approval "inbox-thread-tags", build step 3: "C · The whole row, plus the tag's name"; the picker
 * and the row that follows it: approval "inbox-tag-colors-picker", `.product/approved/inbox-tag-colors-picker/`). A
 * colour is stored as a lowercase `#rrggbb`, from which the window derives the row per theme (inbox/tagColourMap.ts),
 * or one of the five names an earlier Inbox gave (accent, green, amber, red, grey), still read and still written by an
 * older linked Inbox: each shows as a calm colour of its hue (`INBOX_TAG_PRESET_HEX`), accent as calm Indigo. `null`
 * is None: that tag's rows look as usual.
 *
 * A new tag gets a colour by itself (the owner: "Yes", rows coloured right away), the next of the twelve quick
 * swatches, vivid and calm in turn (the owner: "Half vivid, half calm, in turn"), never asked for. Kept in
 * `inbox/tags.json` beside the marks (shared/inbox/thread-tags.ts), by tag id, and on every linked machine that holds a
 * tag of the same name: `inboxTagLookOf` picks one look for the merged tag the same way on every machine. One switch,
 * "Show tag colors" in the list's ⋮, turns every row colour on or off; it is kept the same way, the latest change
 * winning.
 */

const HEX = /^#[0-9a-f]{6}$/;

/** The names an earlier Inbox stored (and an older linked Inbox still may): every one is still a valid colour. */
export const INBOX_TAG_PRESETS = ["accent", "green", "amber", "red", "grey"] as const;
export type InboxTagPreset = (typeof INBOX_TAG_PRESETS)[number];

/** The twelve quick swatches, in the menu's order: the first six vivid, the next six calm, each hue once. */
export const INBOX_TAG_SWATCHES: readonly { name: string; hex: string }[] = [
  { name: "Red", hex: "#ff7e77" },
  { name: "Amber", hex: "#d6a20a" },
  { name: "Green", hex: "#14cc61" },
  { name: "Teal", hex: "#0b9488" },
  { name: "Blue", hex: "#047df1" },
  { name: "Violet", hex: "#a454d7" },
  { name: "Orange", hex: "#c8875a" },
  { name: "Lime", hex: "#8aa35d" },
  { name: "Cyan", hex: "#6ccdea" },
  { name: "Indigo", hex: "#b1b7fd" },
  { name: "Pink", hex: "#eda4cc" },
  { name: "Grey", hex: "#97989b" },
];

const SWATCH = (name: string): string => INBOX_TAG_SWATCHES.find((s) => s.name === name)!.hex;

/** How each stored name shows: the calm colour of its hue (accent and grey are the Indigo and Grey swatches). */
export const INBOX_TAG_PRESET_HEX: Readonly<Record<InboxTagPreset, string>> = {
  accent: SWATCH("Indigo"),
  green: "#8ed09c",
  amber: "#dbb970",
  red: "#f8a49d",
  grey: SWATCH("Grey"),
};

/** The swatch of each stored name's hue, for counting which colours are taken. */
const PRESET_HUE: Readonly<Record<InboxTagPreset, string>> = { accent: "Indigo", green: "Green", amber: "Amber", red: "Red", grey: "Grey" };

/** What a new tag is given, the least used first: vivid and calm in turn, all twelve before any repeats; red late. */
export const INBOX_TAG_AUTO_COLOURS: readonly string[] = ["Green", "Indigo", "Amber", "Pink", "Blue", "Lime", "Teal", "Orange", "Violet", "Cyan", "Red", "Grey"].map(SWATCH);

/** A stored colour as the `#rrggbb` it shows as: a name as its calm colour, a code as itself. */
export function inboxTagShownHex(colour: string): string {
  return isInboxTagPreset(colour) ? INBOX_TAG_PRESET_HEX[colour] : colour;
}

/** A quick swatch's name for a colour that shows as one ("Teal"), else null. */
export function inboxTagSwatchName(colour: string): string | null {
  const hex = inboxTagShownHex(colour);
  return INBOX_TAG_SWATCHES.find((s) => s.hex === hex)?.name ?? null;
}

/** Whether a picked colour goes among the person's own recent ones: a code that is not a quick swatch. */
export function inboxTagOwnColour(colour: unknown): colour is string {
  return typeof colour === "string" && HEX.test(colour) && !INBOX_TAG_SWATCHES.some((s) => s.hex === colour);
}

/** The person's own colours kept for the menu's second line, newest first. */
export const INBOX_TAG_RECENT_MAX = 3;

/**
 * A tag's colour and who set it: `auto` when it was given at creation, `person` once the person picked one or turned
 * Highlight rows off. `colour` is what its rows show; `null` is off (an earlier Inbox's None). Off with a colour kept
 * (the owner: Highlight rows "instantly" on and off, the colour chosen apart): `kept_colour`, so turning it on brings
 * that colour back. An older Inbox ignores the field and reads off as None.
 */
export interface InboxTagLook {
  colour: string | null;
  by: "auto" | "person";
  at: string;
  kept_colour?: string;
}

/** The switch and the person's own colours, as the list model carries them (`tag_colours`). */
export interface InboxTagColours {
  show: boolean;
  /** When the switch was last set (null: never; it is on). */
  show_at: string | null;
  /** The person's own colours, newest first, at most INBOX_TAG_RECENT_MAX. */
  recent: { colour: string; at: string }[];
}

export function isInboxTagPreset(value: unknown): value is InboxTagPreset {
  return typeof value === "string" && (INBOX_TAG_PRESETS as readonly string[]).includes(value);
}

/** A colour as stored: a preset name or a lowercase `#rrggbb`. */
export function isInboxTagColour(value: unknown): value is string {
  return isInboxTagPreset(value) || (typeof value === "string" && HEX.test(value));
}

/** A typed colour as stored: `#abc`, `abc`, `#AABBCC` and `aabbcc` all read; anything else is null. */
export function inboxTagHex(value: string): string | null {
  let v = value.trim().toLowerCase().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/.test(v)) v = [...v].map((c) => c + c).join("");
  return /^[0-9a-f]{6}$/.test(v) ? `#${v}` : null;
}

export function isInboxTagLook(value: unknown): value is InboxTagLook {
  if (!value || typeof value !== "object") return false;
  const look = value as Record<string, unknown>;
  return (look.colour === null || isInboxTagColour(look.colour)) && (look.by === "auto" || look.by === "person") && typeof look.at === "string" && (look.kept_colour === undefined || isInboxTagColour(look.kept_colour));
}

/** A look as stored and sent: `kept_colour` only while off. */
export function inboxTagLook(colour: string | null, by: InboxTagLook["by"], at: string, kept?: string | null): InboxTagLook {
  return colour === null && kept && isInboxTagColour(kept) ? { colour, by, at, kept_colour: kept } : { colour, by, at };
}

/** The colour a tag's rows show when highlighted: the one on, else the one kept while off (null: never had one). */
export function inboxTagLookColour(look: InboxTagLook | undefined): string | null {
  return look ? (look.colour ?? look.kept_colour ?? null) : null;
}

/**
 * The colour a new tag gets: of the twelve in `INBOX_TAG_AUTO_COLOURS`' order, the one fewest live tags show, the
 * first on a tie. A stored name counts as the swatch of its hue (accent as Indigo), so its hue is not given twice.
 */
export function inboxNextTagColour(used: readonly (string | null)[]): string {
  const shown = used.flatMap((c) => (c === null ? [] : [isInboxTagPreset(c) ? SWATCH(PRESET_HUE[c]) : c]));
  let best = INBOX_TAG_AUTO_COLOURS[0]!;
  let fewest = Infinity;
  for (const colour of INBOX_TAG_AUTO_COLOURS) {
    const n = shown.filter((c) => c === colour).length;
    if (n < fewest) {
      best = colour;
      fewest = n;
    }
  }
  return best;
}

/**
 * The one look of a tag that several machines hold, the same whichever machine reads it: a colour the person set
 * beats one given at creation; of two the person set, the later, then the one that keeps a colour while off; of two
 * given, the one of the tag made first (the machine that made it first keeps its colour); then the machine id, so
 * equal times still agree.
 */
export function inboxTagLookOf(held: readonly { machine: string; created_at: string; look: InboxTagLook | undefined }[]): InboxTagLook | undefined {
  let best: (typeof held)[number] | null = null;
  const before = (a: (typeof held)[number], b: (typeof held)[number]): boolean => {
    const pa = a.look!.by === "person";
    const pb = b.look!.by === "person";
    if (pa !== pb) return pa;
    if (pa && a.look!.at !== b.look!.at) return a.look!.at > b.look!.at;
    // Off at the same time on two machines, one an older Inbox that keeps no colour while off: the one that kept it,
    // so turning highlight on again brings it back. Every machine of this version settles on it; an older one (which
    // still takes the lower id) shows the same: off.
    const ka = a.look!.kept_colour !== undefined;
    if (pa && ka !== (b.look!.kept_colour !== undefined)) return ka;
    if (!pa && a.created_at !== b.created_at) return a.created_at < b.created_at;
    return a.machine < b.machine;
  };
  for (const entry of held) {
    if (!entry.look) continue;
    if (!best || before(entry, best)) best = entry;
  }
  return best?.look;
}

/** The switch and the own colours over several machines: the latest switch wins (none set: on); the own colours of all, newest first. */
export function inboxTagColoursOf(all: readonly InboxTagColours[]): InboxTagColours {
  let show: InboxTagColours = { show: true, show_at: null, recent: [] };
  for (const one of all) if (one.show_at !== null && (show.show_at === null || one.show_at > show.show_at)) show = one;
  const recent = all
    .flatMap((one) => one.recent)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .filter((entry, i, list) => list.findIndex((e) => e.colour === entry.colour) === i)
    // A quick swatch an older Inbox kept is not an own colour: dropped before the cut, so it never takes a place.
    .filter((entry) => inboxTagOwnColour(entry.colour))
    .slice(0, INBOX_TAG_RECENT_MAX);
  return { show: show.show, show_at: show.show_at, recent };
}

/** A far machine's `tag_colours` as read from its list: anything malformed reads as nothing set. */
export function inboxTagColoursRead(value: unknown): InboxTagColours | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.show !== "boolean" || !Array.isArray(v.recent)) return null;
  const showAt = typeof v.show_at === "string" ? v.show_at : null;
  if (v.show_at !== null && showAt === null) return null;
  const recent = v.recent.flatMap((e: unknown): { colour: string; at: string }[] => {
    const entry = e as { colour?: unknown; at?: unknown } | null;
    const colour = entry?.colour;
    const at = entry?.at;
    return typeof colour === "string" && HEX.test(colour) && typeof at === "string" ? [{ colour, at }] : [];
  });
  return { show: v.show, show_at: showAt, recent: recent.slice(0, INBOX_TAG_RECENT_MAX) };
}
