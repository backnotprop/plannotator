import { inboxApi } from '../../api';
import { inboxUrl } from '../../inboxUrl';

export async function inboxEmbedUrl(html: string): Promise<string | null> {
  const answer = await inboxApi.embed(html);
  return typeof answer.url === 'string' && answer.url.startsWith(inboxUrl('/embeds/')) ? answer.url : null;
}

/** The URL of a block's annotatable document (ui's `HtmlEmbedAnnotate.frameUrl`). */
export async function inboxEmbedPageUrl(html: string): Promise<string | null> {
  const answer = await inboxApi.embedPage(html);
  return typeof answer.url === 'string' && answer.url.startsWith(inboxUrl('/embed-pages/')) ? answer.url : null;
}
