// Plannotator Inbox is hidden until launch. While this is false the deployed
// site has none of it: /inbox/ and the post are not generated, the post is not
// in the blog collection, the screens and the OG image (inbox-assets/) are not
// copied into dist, and the Nav and the Footer carry no Inbox link.
// Flip at launch (and set the post's `date` to the release day).
// For review before launch, build it locally with the switch on:
//   INBOX_LAUNCHED=true bun run --cwd apps/marketing build
export const INBOX_LAUNCHED = false || process.env.INBOX_LAUNCHED === 'true';

export const INBOX_POST_ID = 'the-age-of-the-inbox';
