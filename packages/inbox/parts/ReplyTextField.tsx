/** The reply box's own field. */
import { useReplyText, type ReplyText } from '../replyText';
import { InboxComposerField, type InboxComposerFieldProps } from '../components/ComposerField';

/** The reply box's field: it alone reads the words (replyText.ts), so a key typed re-renders it and nothing else. */
export function ReplyTextField({ replyText, ...props }: Omit<InboxComposerFieldProps, 'value'> & { replyText: ReplyText }) {
  return <InboxComposerField {...props} value={useReplyText(replyText)} />;
}
