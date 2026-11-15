/** The reply box's field. */
import { useReplyText, type ReplyText } from '../replyText';
import { InboxComposerField, type InboxComposerFieldProps } from '../components/ComposerField';

/** The reply box's field: it alone reads the words (replyText.ts), so a key typed re-renders it and nothing else. */
export function ReplyTextField({ replyText, sendingWords = false, ...props }: Omit<InboxComposerFieldProps, 'value'> & { replyText: ReplyText; sendingWords?: boolean }) {
  const words = useReplyText(replyText);
  return <InboxComposerField {...props} value={sendingWords ? '' : words} />;
}
