/** The list's tags and their colours on the wire (inbox-tag-colours.ts), and the colour writes. */
import type { InboxTagColours, InboxTagLook } from '@plannotator/core/inbox-types';
import { post } from '../../api';
import { inboxUrl } from '../../inboxUrl';

export type { ListTagsFields } from '@plannotator/core/inbox-wire-models';

export const tagColoursApi = {
  /**
   * A tag's row colour (a preset or `#rrggbb`), or null: Highlight rows off, keeping `kept` for when it is on again (an
   * older machine ignores it and reads None); as of `at`; `machine`: that linked machine's tag of the name.
   */
  set: (tag: string, colour: string | null, at: string, machine?: string | null, kept?: string | null) =>
    post<{ look: InboxTagLook; tag_colours: InboxTagColours }>(inboxUrl('/tag-colours', undefined, machine), colour === null && kept ? { tag, colour, at, kept_colour: kept } : { tag, colour, at }),
  /** "Show tag colors" in the list's ⋮, as of `at`, here or on a linked machine. */
  shown: (show: boolean, at: string, machine?: string | null) => post<{ tag_colours: InboxTagColours }>(inboxUrl('/tag-colours', undefined, machine), { show, at }),
};
