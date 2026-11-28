import { inboxApi, post } from '../../api';
import { inboxUrl } from '../../inboxUrl';

export async function inboxEmbedUrl(html: string): Promise<string | null> {
  const answer = await inboxApi.embed(html);
  return typeof answer.url === 'string' && answer.url.startsWith(inboxUrl('/embeds/')) ? answer.url : null;
}

/**
 * The URL of a block's annotatable document (ui's `HtmlEmbedAnnotate.frameUrl`): its page with the annotation
 * bridge, kept by the Inbox and served under the embed's own policy (inbox-embeds.ts). About 300 KB, sent gzipped.
 */
export async function inboxEmbedPageUrl(html: string): Promise<string | null> {
  const answer = await post<{ id: string; url: string }>(inboxUrl('/embed-pages'), { html }, { gzip: true });
  return typeof answer.url === 'string' && answer.url.startsWith(inboxUrl('/embed-pages/')) ? answer.url : null;
}
