/**
 * Every word of the "Star the repo" ask (approval "star-ask"), in one place so they can be swapped in one edit. The
 * owner's pick (q-bc8be138, 2026-11-06): the short words everywhere, the Inbox's corner card and the done screen's card
 * alike, with no "We'll only ask once." line.
 *
 * The art's words (`art`) are drawn in two subset faces (utils/starAskFonts.ts): lower-case a-z, space, "?", "." and
 * "!" for the big line, a-z, space and "·" for the small row. The big line is solved to the measure at run time, so a
 * new word still fills it.
 */
export const STAR_ASK_WORDS = {
  title: 'Would you star Plannotator?',
  body: 'It’s free and open source. A star helps more people find it, and helps us keep it going.',
  notNow: 'Not now',
  star: 'Star on GitHub',
  starring: 'Starring…',
  /** gh starred it. */
  starred: 'Starred. Thank you!',
  /** The link opened GitHub in a new tab (no gh, or gh could not check). */
  opened: 'Thank you! GitHub is open in a new tab.',
  /** gh could not star it on the click (a token not allowed to star, the network): the link follows. */
  failed: 'Couldn’t star it from here.',
  openGitHub: 'Open GitHub',
  close: 'Close',
  art: {
    label: 'plannotator · open source',
    ask: 'a small ask',
    after: 'decided · recorded',
    big: 'star it?',
    bigAfter: 'starred.',
  },
} as const;

export type StarAskWords = typeof STAR_ASK_WORDS;
