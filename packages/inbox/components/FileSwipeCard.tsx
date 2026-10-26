import { readInboxAttachmentKind } from '@plannotator/core/inbox-types';
import { attachmentImageUrl, readableVersion } from '../attachments';
import { useSwipeProgress, type FileSwipe } from '../fileSwipe';
import { Icon } from '../icons';
import type { AttachmentStep } from '../stepping';
import { peekTile } from './AttachmentStepper';
import { FileName } from './FileName';

/**
 * The file a phone's swipe is bringing in (fileSwipe.ts): "Next · name" (or
 * "Previous · name") with its thumbnail or type tile, at the edge it comes
 * from, fading in with the finger's travel. Only while a swipe is under way;
 * hidden from screen readers (the step is said in the pane's live region).
 */
export function FileSwipeCard({ swipe, steps, index }: { swipe: FileSwipe; steps: readonly AttachmentStep[]; index: number }) {
  const progress = useSwipeProgress(swipe);
  if (!progress) return null;
  const step = steps[index + progress.dir];
  if (!step) return null;
  const { attachment } = step;
  const next = progress.dir > 0;
  return (
    <div
      className={`ib-swipecard ${next ? 'ib-swipecard-r' : 'ib-swipecard-l'}`}
      style={{ opacity: Math.min(1, progress.progress * 2.4) }}
      aria-hidden="true"
      data-file-swipe-card={next ? 'next' : 'previous'}
    >
      {!next && <Icon name="chevL" size={16} />}
      <span className={`ib-swipecard-th${readInboxAttachmentKind(attachment.kind) === 'image' ? '' : ' ib-swipecard-th-tile'}`}>
        {readInboxAttachmentKind(attachment.kind) === 'image' ? (
          <img src={attachmentImageUrl(attachment, readableVersion(attachment))} alt="" width={28} height={28} draggable={false} />
        ) : (
          <span className="ib-swipecard-tile">{peekTile(attachment)}</span>
        )}
      </span>
      <span className="ib-swipecard-text">
        <span className="ib-swipecard-dir">{next ? 'Next' : 'Previous'}</span>
        <b className="ib-swipecard-nm">
          <FileName name={attachment.name} />
        </b>
      </span>
      {next && <Icon name="chevR" size={16} />}
    </div>
  );
}
