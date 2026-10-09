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
 * longer what was sent. The whole tile opens the file; Open is its cue.
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
          const detailId = `ib-att-detail-${attachment.id}`;
          // The whole tile is the one control (record 2.1): a click on the
          // icon, the name or the type line opens the file exactly as Open
          // does. "Open" stays as the visual cue inside it.
          return (
            <button
              type="button"
              className="ib-att-t"
              key={attachment.id}
              onClick={() => onOpen(attachment)}
              aria-label={`Open ${attachment.name}`}
              aria-describedby={detailId}
              data-attachment-id={attachment.id}
              data-attachment-name={attachment.name}
            >
              <span className="ib-fi">
                <Icon name={iconOf(attachment)} size={16} />
              </span>
              <span className="ib-att-text">
                <span className="ib-nm">{attachment.name}</span>
                <span className={changed ? 'ib-ch' : 'ib-kd'} id={detailId}>
                  {detail}
                </span>
              </span>
              <span className="ib-open">Open</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
