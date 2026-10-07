import { inboxAttachmentKindLabel, type InboxAttachmentState } from '@plannotator/core/inbox-types';
import { clockTime, plural } from '../format';
import { Icon, type IconName } from '../icons';

function iconOf(attachment: InboxAttachmentState): IconName {
  if (attachment.kind === 'html') return 'code';
  if (attachment.kind === 'mermaid' || attachment.kind === 'graphviz') return 'diagram';
  return 'doc';
}

/**
 * The files at the foot of a message (record 2.1): a tile per file with its
 * kind and annotation count, or the changed line when the file on disk is no
 * longer what was sent, and Open.
 */
export function AttachmentTiles({
  attachments,
  annotationCounts,
  onOpen,
}: {
  attachments: readonly InboxAttachmentState[];
  annotationCounts: ReadonlyMap<string, number>;
  onOpen: (attachment: InboxAttachmentState) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="ib-attachments">
      <div className="ib-attach-h">
        <Icon name="clip" size={13} />
        {plural(attachments.length, 'attachment')}
      </div>
      <div className="ib-atts">
        {attachments.map((attachment) => {
          const count = annotationCounts.get(attachment.path) ?? 0;
          let detail: string;
          let changed = false;
          if (attachment.unavailable) {
            detail = attachment.unavailable.code === 'attachment_missing' ? 'No longer on disk; the sent version opens' : 'Changed type; the sent version opens';
            changed = true;
          } else if (attachment.changed_since_sent && attachment.current) {
            detail = `Changed since it was sent, edited ${clockTime(attachment.current.mtime)}`;
            changed = true;
          } else {
            detail = `${inboxAttachmentKindLabel(attachment.kind, attachment.name)}${count > 0 ? `, ${plural(count, 'annotation')}` : ''}`;
          }
          return (
            <div className="ib-att-t" key={attachment.id} data-attachment-id={attachment.id} data-attachment-name={attachment.name}>
              <span className="ib-fi">
                <Icon name={iconOf(attachment)} size={16} />
              </span>
              <span>
                <div className="ib-nm">{attachment.name}</div>
                <div className={changed ? 'ib-ch' : 'ib-kd'}>{detail}</div>
              </span>
              <button type="button" className="ib-open" onClick={() => onOpen(attachment)} aria-label={`Open ${attachment.name}`}>
                Open
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
