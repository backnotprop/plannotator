import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Annotation, Block } from '@plannotator/ui/types';
import { DocumentContents } from '@plannotator/ui/components/DocumentContents';
import { Icon } from '../icons';
import { peekSheetHost } from './AttachmentStepper';
import { Tip } from './Tip';

export type ContentsButtonMode = 'show' | 'sheet';

interface Props {
  mode: ContentsButtonMode;
  blocks: Block[];
  annotations: Annotation[];
  scrollViewport: HTMLElement | null;
  onShow: () => void;
  phone?: boolean;
}

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

export function ContentsHide({ onHide }: { onHide: () => void }) {
  return (
    <Tip content="Hide contents">
      <button type="button" className="ib-iconbtn ib-contents-hide" onClick={onHide} aria-label="Hide contents" data-contents-hide="">
        <Icon name="eyeOff" size={14} />
      </button>
    </Tip>
  );
}

const SHEET_FOCUSABLE = 'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

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
    // Capture phase: runs before the pane's Escape ladder and the shortcut scopes.
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
