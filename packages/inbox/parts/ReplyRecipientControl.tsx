import type { ComponentProps } from 'react';
import { PhoneReplyRecipient } from '../components/PhoneReplyRecipient';
import { ReplyRecipient } from '../components/ReplyRecipient';

/**
 * The one place a thread's reply recipient control splits: a phone's is in the box's row with its sheet (approval
 * "inbox-phone-composer-picker", kept there by the owner, 2026-11-20), a computer's is the chip at the start of the
 * words, the field's lead ("inbox-reply-target-chip"). Both show by the same rule (Thread's `pillActive`): a thread with
 * one agent has no control at all.
 */
export function ReplyRecipientControl({ phone, ...props }: ComponentProps<typeof PhoneReplyRecipient> & { phone: boolean }) {
  if (phone) return <PhoneReplyRecipient {...props} />;
  const { section: _section, ...rest } = props;
  return <ReplyRecipient chip {...rest} />;
}
