import { inboxApi } from '../../api';
import { inboxUrl } from '../../inboxUrl';

/** The URL of a fence's embed document: the Inbox keeps the page and serves it under its own policy. */
export async function inboxEmbedUrl(html: string): Promise<string | null> {
  const answer = await inboxApi.embed(html);
  return typeof answer.url === 'string' && answer.url.startsWith(inboxUrl('/embeds/')) ? answer.url : null;
}
