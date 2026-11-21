import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Annotation, Block } from '@plannotator/ui/types';
import { DocumentContents } from '@plannotator/ui/components/DocumentContents';
import { Icon } from '../icons';
import { peekSheetHost } from './AttachmentStepper';
import { Tip } from './Tip';

/**
 * The Contents button over an open document, when ui's contents rail is not on screen (contents.ts):
 * - `show`: the rail fits but was hidden; the button shows it again;
 * - `sheet`: the rail does not fit (a gutter under 68 px, a pane under 480 px), has not measured yet, or the
 *   window is a phone; the button opens the rail's headings (ui's DocumentContents) as a sheet over the window.
 */
export type ContentsButtonMode = 'show' | 'sheet';

interface Props {
  mode: ContentsButtonMode;
  blocks: Block[];
  annotations: Annotation[];
  /** The document's scroll element (`.ib-docscroll`). */
  scrollViewport: HTMLElement | null;
  /** `show`: put the rail back. */
  onShow: () => void;
  /** The window is phone-sized: the sheet's rows are 44 px touch targets in readable type. */
  phone?: boolean;
}

/** The way to an open document's Contents when the rail is not on screen. */
export function ContentsPanel(props: Props) {
  if (props.mode === 'sheet') return <ContentsSheet {...props} />;
  return (
    <Tip content="Show contents">
      <button type="button" className="ib-iconbtn ib-contents-open" onClick={props.onShow} aria-label="Show contents" data-contents-show="">
        <Icon name="contents" size={16} />
      </button>
    </Tip>
  );
}

/** The open rail panel's Hide (ui's `panelAction`): the rail goes, a Contents button over the file brings it back. */
export function ContentsHide({ onHide }: { onHide: () => void }) {
  return (
    <Tip content="Hide contents">
      <button type="button" className="ib-iconbtn ib-contents-hide" onClick={onHide} aria-label="Hide contents" data-contents-hide="">
        <Icon name="eyeOff" size={14} />
      </button>
    </Tip>
  );
}

/** What can take focus inside the sheet, in order: Tab wraps among these while it is open. */
const SHEET_FOCUSABLE = 'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * A button over the file opens the list as a sheet over the window; a pick scrolls there and closes it.
 * The sheet is modal while open: Tab wraps inside it, and Escape closes it first wherever focus is (before
 * full screen's Escape ladder sees the key). Focus goes back to the Contents button.
 */
function ContentsSheet(props: Props) {
  const [open, setOpen] = useState(false);
  const openRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) closeRef.current?.focus({ preventScroll: true });
    else if (wasOpen.current) openRef.current?.focus({ preventScroll: true });
    wasOpen.current = open;
  }, [open]);
  useEffect(() => {
    if (!open) return;
    // The window's capture phase runs before the pane's ladder and the shortcut scopes (AnnotationsChip's way).
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
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
  }, [open]);
  const host = open ? peekSheetHost(openRef.current) : null;
  return (
    <>
      <Tip content="Contents">
        <button
          ref={openRef}
          type="button"
          className="ib-iconbtn ib-contents-open"
          onClick={() => setOpen(true)}
          aria-label="Contents"
          aria-expanded={open}
          data-contents-open=""
        >
          <Icon name="contents" size={16} />
        </button>
      </Tip>
      {host &&
        createPortal(
          <>
            <button type="button" className="ib-contents-scrim" aria-label="Close contents" tabIndex={-1} onClick={() => setOpen(false)} />
            <div
              ref={sheetRef}
              className={`ib-contents ib-contents-sheet${props.phone ? ' ib-contents-phone' : ''}`}
              data-contents="sheet"
              role="dialog"
              aria-modal="true"
              aria-label="Contents"
              // A click on the sheet's blank space keeps focus in the sheet, not on the page behind it.
              tabIndex={-1}
            >
              <div className="ib-contents-h">
                <span className="ib-contents-t">Contents</span>
                <button ref={closeRef} type="button" className="ib-iconbtn" onClick={() => setOpen(false)} aria-label="Close contents">
                  <Icon name="x" size={16} />
                </button>
              </div>
              <div className="ib-contents-list">
                <DocumentContents
                  blocks={props.blocks}
                  annotations={props.annotations}
                  scrollViewport={props.scrollViewport}
                  onNavigate={() => setOpen(false)}
                />
              </div>
            </div>
          </>,
          host,
        )}
    </>
  );
}
