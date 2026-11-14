import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Link2, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useDismissablePopover } from '@plannotator/ui/hooks/useDismissablePopover';
import { GuideShareHost, useGuideExportInfo } from './GuideExportButton';

const ITEM =
  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-foreground hover:bg-muted focus-visible:bg-muted focus-visible:outline-none disabled:cursor-not-allowed disabled:text-muted-foreground disabled:hover:bg-transparent';

export function GuideRowMenu({ id, title, onRename, onDelete }: { id: string; title: string; onRename: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const jobId = `saved:${id}`;
  const exportInfo = useGuideExportInfo(jobId, everOpened);
  const close = useCallback(() => setOpen(false), []);
  useDismissablePopover({ enabled: open, ref: panel, onDismiss: close });

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const r = trigger.current.getBoundingClientRect();
    const below = r.bottom + 4;
    const height = 156;
    setPos({ top: below + height > window.innerHeight ? Math.max(8, r.top - height - 4) : below, right: Math.max(8, window.innerWidth - r.right) });
  }, [open]);

  const { info, share, setShareOpen, encoded } = exportInfo;
  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={`More actions for ${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onPointerDown={(e) => {
          if (open) e.stopPropagation();
        }}
        onClick={(e) => {
          e.stopPropagation();
          setEverOpened(true);
          setOpen((v) => !v);
        }}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100 group-focus-within:opacity-100 aria-expanded:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <MoreHorizontal size={14} />
      </button>
      {open && pos &&
        createPortal(
          <div
            ref={panel}
            role="menu"
            data-pn-dismissable-popover="true"
            data-guide-row-menu=""
            style={{ position: 'fixed', top: pos.top, right: pos.right }}
            className="z-[80] w-52 rounded-lg border border-border bg-popover py-1 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <button type="button" role="menuitem" className={ITEM} onClick={pick(onRename)}>
              <Pencil size={13} className="text-muted-foreground" /> Rename
            </button>
            {info ? (
              <a role="menuitem" className={ITEM} href={`/api/guide/${encoded}/export`} download={info.filename} onClick={() => setOpen(false)}>
                <Download size={13} className="text-muted-foreground" /> Download portable guide
              </a>
            ) : (
              <button type="button" role="menuitem" className={ITEM} disabled title="Its diff was not kept, so it cannot be exported">
                <Download size={13} /> Download portable guide
              </button>
            )}
            {share?.enabled && info && (
              <button type="button" role="menuitem" className={ITEM} onClick={pick(() => setShareOpen(true))}>
                <Link2 size={13} className="text-muted-foreground" /> {share.existing ? 'Share link' : 'Create share link'}
              </button>
            )}
            <div className="my-1 h-px bg-border" />
            <button type="button" role="menuitem" className={ITEM} onClick={pick(onDelete)}>
              <Trash2 size={13} className="text-muted-foreground" /> Delete
            </button>
          </div>,
          document.body,
        )}
      <GuideShareHost jobId={jobId} exportInfo={exportInfo} />
    </>
  );
}
