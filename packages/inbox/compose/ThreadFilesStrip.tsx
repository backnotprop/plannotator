/**
 * New message over an open thread offers that thread's files, one click each
 * (approval "reuse-attachments"). Only the thread behind the dialog, never a list
 * of everything, and nothing is kept anywhere but the message's own files.
 */
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';
import { readInboxAttachmentKind } from '@plannotator/core/inbox-types';
import { attachmentImageUrl, readableVersion } from '../attachments';
import { Icon } from '../icons';
import { iconOf } from '../components/AttachmentTiles';
import { Tip } from '../components/Tip';
import { sourceOf } from '../reuse';
import type { useComposeFiles } from './ComposeFiles';

const MOST = 8;

export function ThreadFilesStrip({ threadFiles, files }: { threadFiles: readonly InboxAttachmentState[] | null | undefined; files: ReturnType<typeof useComposeFiles> }) {
  if (!threadFiles || threadFiles.length === 0 || !files.canReuse) return null;
  const sourceFor = (file: InboxAttachmentState) => sourceOf(file, readableVersion(file), attachmentImageUrl);
  // Newest first, and each file's bytes once: a reply that re-sent a picture does not show it twice.
  const seen = new Set<string>();
  const shown = [...threadFiles]
    .sort((a, b) => b.sent_at.localeCompare(a.sent_at))
    .filter((file) => {
      const { sha256 } = sourceFor(file);
      if (seen.has(sha256)) return false;
      seen.add(sha256);
      return true;
    })
    .slice(0, MOST);
  return (
    <div className="ib-cp-from" data-compose-from="">
      <span className="ib-cp-from-l">From this thread</span>
      <div className="ib-cp-from-row">
        {shown.map((file) => {
          const source = sourceFor(file);
          const added = Boolean(files.holding(source.sha256));
          const picture = readInboxAttachmentKind(file.kind) === 'image' && source.preview;
          return (
            <Tip key={file.id} content={added ? `${file.name} is in this message` : `Add ${file.name}`}>
              <button
                type="button"
                tabIndex={0}
                className={`ib-cp-from-t${added ? ' ib-on' : ''}`}
                aria-label={added ? `${file.name} is in this message. Take it out` : `Add ${file.name} to this message`}
                aria-pressed={added}
                data-compose-from-file={file.id}
                onClick={() => (added ? files.removeHolding(source.sha256) : files.addExisting(source))}
              >
                {picture ? <img src={source.preview} alt="" draggable={false} /> : !added && <Icon name={iconOf(file)} size={16} />}
                {added && (
                  <span className={`ib-cp-from-c${picture ? '' : ' ib-cp-from-c-file'}`} aria-hidden="true">
                    <Icon name="check" size={picture ? 12 : 16} />
                  </span>
                )}
              </button>
            </Tip>
          );
        })}
      </div>
    </div>
  );
}
