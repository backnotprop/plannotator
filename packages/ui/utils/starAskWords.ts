export const STAR_ASK_WORDS = {
  title: 'Would you star Plannotator?',
  body: 'It’s free and open source. A star helps more people find it, and helps us keep it going.',
  notNow: 'Not now',
  star: 'Star on GitHub',
  starring: 'Starring…',
  starred: 'Starred. Thank you!',
  opened: 'Thank you! GitHub is open in a new tab.',
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
