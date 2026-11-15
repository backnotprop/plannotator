/**
 * A tag's row colour (approval "inbox-thread-tags", build step 3: "C · The whole row, plus the tag's name"; own
 * colour "B · A colour strip and a code field"). A colour is a preset name, each a theme token the window already
 * has (accent `--primary`, green `--success`, amber `--warning`, red `--destructive`, grey the muted text), or a
 * person's own `#rrggbb`, from which the window derives one colour per theme (inbox/tagColours.ts). `null` is None:
 * that tag's rows look as usual.
 *
 * A new tag gets a colour by itself (the owner: "Yes", rows coloured right away), the next unused one of the calm set
 * (`INBOX_TAG_AUTO_COLOURS`), never asked for. Kept in `inbox/tags.json` beside the marks (shared/inbox/thread-tags.ts),
 * by tag id, and on every linked machine that holds a tag of the same name: `inboxTagLookOf` picks one look for the
 * merged tag the same way on every machine. One switch, "Show tag colors" in the list's ⋮, turns every row colour
 * on or off; it is kept the same way, the latest change winning.
 */

/** The presets, in the colour menu's order. */
export const INBOX_TAG_PRESETS = ["accent", "green", "amber", "red", "grey"] as const;
export type InboxTagPreset = (typeof INBOX_TAG_PRESETS)[number];

/** What a new tag is given, in this order, the least used first: red is left out (it reads as an error). */
export const INBOX_TAG_AUTO_COLOURS: readonly InboxTagPreset[] = ["green", "amber", "accent", "grey"];

/** The person's own colours kept for the menu's second line, newest first. */
export const INBOX_TAG_RECENT_MAX = 3;

/** A tag's colour and who set it: `auto` when it was given at creation, `person` once the person picked one or None. */
export interface InboxTagLook {
  colour: string | null;
  by: "auto" | "person";
  at: string;
}

/** The switch and the person's own colours, as the list model carries them (`tag_colours`). */
export interface InboxTagColours {
  show: boolean;
  /** When the switch was last set (null: never; it is on). */
  show_at: string | null;
  /** The person's own colours, newest first, at most INBOX_TAG_RECENT_MAX. */
  recent: { colour: string; at: string }[];
}

const HEX = /^#[0-9a-f]{6}$/;

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
  return (look.colour === null || isInboxTagColour(look.colour)) && (look.by === "auto" || look.by === "person") && typeof look.at === "string";
}

/** The colour a new tag gets: of the calm set, the one fewest live tags have, the first in the set on a tie. */
export function inboxNextTagColour(used: readonly (string | null)[]): InboxTagPreset {
  let best: InboxTagPreset = INBOX_TAG_AUTO_COLOURS[0]!;
  let fewest = Infinity;
  for (const colour of INBOX_TAG_AUTO_COLOURS) {
    const n = used.filter((c) => c === colour).length;
    if (n < fewest) {
      best = colour;
      fewest = n;
    }
  }
  return best;
}

/**
 * The one look of a tag that several machines hold, the same whichever machine reads it: a colour the person set
 * beats one given at creation; of two the person set, the later; of two given, the one of the tag made first (the
 * machine that made it first keeps its colour); then the machine id, so equal times still agree.
 */
export function inboxTagLookOf(held: readonly { machine: string; created_at: string; look: InboxTagLook | undefined }[]): InboxTagLook | undefined {
  let best: (typeof held)[number] | null = null;
  const before = (a: (typeof held)[number], b: (typeof held)[number]): boolean => {
    const pa = a.look!.by === "person";
    const pb = b.look!.by === "person";
    if (pa !== pb) return pa;
    if (pa && a.look!.at !== b.look!.at) return a.look!.at > b.look!.at;
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
