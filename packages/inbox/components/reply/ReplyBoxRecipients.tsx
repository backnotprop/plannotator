/**
 * The reply box's recipient control from plain data (`ReplyBoxRecipients`): the list in, who gets the reply out
 * (`onChange(to)`). A row picked alone sends to it and closes the list; a tick adds or removes a row, up to
 * `maxRecipients`; with 1 there are no ticks and the list picks one. The control itself is the Inbox's
 * (parts/ReplyRecipientControl): a phone's in the box's row, a computer's the chip leading the words.
 */
import { RECIPIENTS_MAX, toggleRecipient } from '../../replyRecipients';
import type { SessionLabels } from '../../sessionLabels';
import { ReplyRecipientControl } from '../../parts/ReplyRecipientControl';
import type { ReplyBoxRecipients } from './replyBoxSeams';

const NO_LABELS: SessionLabels = {};
const NO_FOLDER = () => '';

export function ReplyBoxRecipientControl({ phone, recipients }: { phone: boolean; recipients: ReplyBoxRecipients }) {
  const { rows, chosen, open, onOpen, onChange, maxRecipients, toggle, onTagAnother, onRemove, labels = NO_LABELS, folderOf = NO_FOLDER, section = null } = recipients;
  const max = maxRecipients ?? RECIPIENTS_MAX;
  const alone = (id: string) => rows.find((row) => row.session === id)?.alone !== false;
  return (
    <ReplyRecipientControl
      phone={phone}
      rows={rows}
      chosen={chosen}
      open={open}
      onOpen={onOpen}
      onOnly={(row) => {
        onChange([row.session]);
        onOpen(false);
      }}
      onToggle={max <= 1 ? undefined : (row) => onChange(toggle ? toggle(row) : toggleRecipient(chosen.map((one) => one.session), row.session, max, alone))}
      onTagAnother={onTagAnother}
      onRemove={onRemove}
      section={section}
      labels={labels}
      folderOf={folderOf}
      max={max}
    />
  );
}
