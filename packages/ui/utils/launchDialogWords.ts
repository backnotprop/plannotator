/**
 * Every word of the launch dialog (the launch switch, packages/shared/launch-switch.ts), in one place. Approved by the
 * owner character for character (2026-11-25) and fixed in the release: launch.json carries no text. Never the words
 * vote or upvote.
 */
export const LAUNCH_DIALOG_WORDS = {
  title: 'Plannotator Inbox is live on Product Hunt',
  line: 'We launched today. Come see it and tell us what you think.',
  open: 'See the launch',
  notNow: 'Not now',
} as const;

/**
 * The art band's picture: one 16:9 image (1120×630 or 1440×810, WebP) for both themes, carrying its own ground. Committed to the
 * marketing site (`apps/marketing/public/launch/<campaign>.webp`), so a reviewed merge deploys it;
 * `apps/marketing/launch-art.test.ts` holds the campaign launch.json names to it. The Inbox's window policy allows
 * pictures from this one folder (`WINDOW_CSP` img-src); the plan, review and annotate pages set no picture policy.
 */
export const LAUNCH_ART_BASE = 'https://plannotator.ai/launch/';

/** A campaign as the launch switch accepts it (packages/shared/launch-switch.ts `CAMPAIGN`). */
const CAMPAIGN = /^[a-z0-9-]{1,40}$/;

/** The art for a campaign, or null for a name the switch would never send. */
export function launchArtUrl(campaign: string): string | null {
  return CAMPAIGN.test(campaign) ? `${LAUNCH_ART_BASE}${campaign}.webp` : null;
}

/**
 * The art's text alternative. Empty (decorative): the title beside it already says what the art says. If the art
 * ever carries words the title does not, set it to 'Plannotator Inbox on Product Hunt'.
 */
export const LAUNCH_ART_ALT = '';

/** How long the art may take before the dialog drops the band and shows its words alone. */
export const LAUNCH_ART_WAIT_MS = 2000;
