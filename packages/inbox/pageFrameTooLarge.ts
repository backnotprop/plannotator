/**
 * An attached page's served frame (`InboxFileSource.pageFrameUrl`, HtmlViewer's `frameUrl`) that tells its pane when
 * the Inbox refuses the page as too large to keep (`page_too_large`, inbox-pages.ts `INBOX_PAGE_MAX_BYTES`): the pane
 * then shows its "too large to show here" card, never an empty frame.
 */
import { InboxApiError } from './apiError';

export function pageFrameTooLarge(frame: ((html: string) => Promise<string | null>) | undefined, onTooLarge: () => void): ((html: string) => Promise<string | null>) | undefined {
  if (!frame) return undefined;
  return async (html) => {
    try {
      return await frame(html);
    } catch (cause) {
      if (cause instanceof InboxApiError && cause.code === 'page_too_large') onTooLarge();
      throw cause;
    }
  };
}
