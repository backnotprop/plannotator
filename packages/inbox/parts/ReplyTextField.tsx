/** The reply box's field. */
import { useReplyText, type ReplyText } from '../replyText';
import { ComposerFieldBase, type InboxComposerFieldProps } from '../components/ComposerFieldBase';

/**
 * The reply box's field: it alone reads the words (replyText.ts), so a key typed re-renders it and nothing else. It is
 * the composer field's base: voice is drawn only with the `voiceParts` the box was handed (reply/replyVoice.ts).
 */
export function ReplyTextField({ replyText, sendingWords = false, ...props }: Omit<InboxComposerFieldProps, 'value'> & { replyText: ReplyText; sendingWords?: boolean }) {
  const words = useReplyText(replyText);
  return <ComposerFieldBase {...props} value={sendingWords ? '' : words} />;
}
