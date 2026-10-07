// Plannotator Inbox is hidden until launch. While this is false the Nav and
// the Footer carry no Inbox link, and /inbox/ and the post stay routable by URL
// for review but are noindex and left out of the sitemap, the blog index and
// the RSS feed.
// Flip at launch (and set the post's `date` to the release day).
export const INBOX_LAUNCHED = false;

export const INBOX_POST_ID = 'the-age-of-the-inbox';

/** A post that is built but kept out of listings and search until its launch. */
export const isUnlaunchedPost = (postId: string): boolean =>
  !INBOX_LAUNCHED && postId === INBOX_POST_ID;
