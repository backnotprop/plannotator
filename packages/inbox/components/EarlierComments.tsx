import { useEffect, useRef, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import type { EarlierReply } from '../earlierComments';
import { Icon } from '../icons';
import { peekSheetHost } from './AttachmentStepper';

/**
 * What opens the panel. The one piece a change of entry point replaces: the pane draws it with these props and
 * knows nothing else about it. It carries `data-earlier-entry` on what takes focus, where focus returns on close.
 */
export interface EarlierEntryProps {
  count: number;
  open: boolean;
  /** The panel's id, for `aria-controls`. */
  panelId: string;
  onToggle: () => void;
}
export type EarlierEntry = ComponentType<EarlierEntryProps>;

interface ListProps {
  replies: readonly EarlierReply[];
  count: number;
  onClose: () => void;
  closeRef?: React.Ref<HTMLButtonElement>;
}

function EarlierList({ replies, count, onClose, closeRef }: ListProps) {
  return (
    <>
      <div className="ib-earlier-h">
        <b>Earlier comments</b>
        <span className="ib-earlier-n">{count}</span>
        <button ref={closeRef} type="button" className="ib-iconbtn" onClick={onClose} aria-label="Close earlier comments" data-earlier-close="">
          <Icon name="x" size={15} />
        </button>
      </div>
      {/* Reachable by Tab, so a long list scrolls from the keyboard. */}
      <div className="ib-earlier-list" tabIndex={0} data-earlier-list="">
        {replies.map((reply) => (
          <section key={reply.replyId} className="ib-earlier-reply">
            <div className="ib-earlier-sub">{reply.label}</div>
            {reply.comments.map((comment) => (
              <div key={comment.id} className="ib-earlier-item" data-earlier-comment={comment.id}>
                <p className="ib-earlier-t">{comment.words}</p>
                {comment.spot && <span className="ib-earlier-m">{comment.spot}</span>}
              </div>
            ))}
          </section>
        ))}
      </div>
    </>
  );
}

interface PanelProps extends Omit<ListProps, 'closeRef'> {
  id: string;
  open: boolean;
}

/**
 * The slim panel at the file's right edge, in `.ib-docarea`, so it is the same in every mode. It stays mounted, so
 * it slides both ways; hidden, nothing in it takes focus. It is not modal: the file keeps its clicks and focus does
 * not move on open. Escape closes it through the pane's ladder (the `earlier` rung).
 */
export function EarlierCommentsPanel({ id, open, ...list }: PanelProps) {
  return (
    <div className="ib-earlier-stage">
      <aside id={id} className="ib-earlier-panel" aria-label="Earlier comments" data-visible={open ? '' : undefined} data-earlier-panel="">
        <EarlierList {...list} />
      </aside>
    </div>
  );
}

/** What can take focus inside the sheet, in order: Tab wraps among these while it is open. */
const SHEET_FOCUSABLE = 'button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A phone's bottom sheet over the window, while open: modal, as the Contents sheet is (ContentsPanel.tsx). Tab wraps
 * inside it, focus starts on its close, and it takes Escape first wherever focus is. The pane puts focus back.
 */
export function EarlierCommentsSheet({ id, near, ...list }: Omit<ListProps, 'closeRef'> & { id: string; near: Element | null }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const { onClose } = list;
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    // The window's capture phase runs before the pane's ladder and the shortcut scopes.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      const sheet = sheetRef.current;
      if (event.key !== 'Tab' || !sheet) return;
      const items = [...sheet.querySelectorAll<HTMLElement>(SHEET_FOCUSABLE)];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      const inside = active instanceof Node && sheet.contains(active) && active !== sheet;
      if (event.shiftKey ? !inside || active === first : !inside || active === last) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const host = peekSheetHost(near);
  if (!host) return null;
  return createPortal(
    <>
      <button type="button" className="ib-earlier-scrim" aria-label="Close earlier comments" tabIndex={-1} onClick={onClose} />
      <div ref={sheetRef} id={id} className="ib-earlier-sheet" role="dialog" aria-modal="true" aria-label="Earlier comments" tabIndex={-1} data-earlier-panel="">
        <EarlierList {...list} closeRef={closeRef} />
      </div>
    </>,
    host,
  );
}
