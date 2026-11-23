/** The file pane's comments button (AttachmentPane.tsx): it opens the comments sheet where the panel is folded. */
import type { Ref } from 'react';
import { Icon } from '../icons';
import { CommentCount, commentsLabel } from '../components/EarlierSection';

export function PaneCommentsButton({ buttonRef, open, count, earlier, controls, onToggle, onEscape }: { buttonRef: Ref<HTMLButtonElement>; open: boolean; count: number; earlier: number; controls: string; onToggle: () => void; onEscape: () => void }) {
  return (
    <button
      type="button"
      ref={buttonRef}
      className={`ib-btn ib-sm ib-vcomments${open ? ' ib-on' : ''}`}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open && !event.defaultPrevented) {
          event.preventDefault();
          onEscape();
        }
      }}
      aria-expanded={open}
      aria-controls={controls}
      aria-label={commentsLabel(count, earlier)}
      data-annotations-sheet=""
    >
      <Icon name="comment" size={15} />
      <CommentCount count={count} earlier={earlier} />
    </button>
  );
}
