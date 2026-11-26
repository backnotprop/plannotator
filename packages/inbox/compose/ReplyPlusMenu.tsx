/**
 * The reply box's + (in place of its paperclip): a menu that rises from the button, with "Attach a file" and, where
 * the thread can have a canvas, "Canvas". The owner's choice ("A · A plus replaces the clip", "It rises from the
 * button"), on a computer and on a phone alike.
 *
 * - Attach a file opens the very picker the paperclip opened: the same hidden `<input type="file" multiple>` (with
 *   its `data-reply-attach`, a phone's photo library too), kept outside the menu so it is there after the menu
 *   closes. Dragging files onto the box and pasting them are the box's own and unchanged.
 * - Canvas opens the thread's canvas (canvas/useThreadCanvas.tsx `openFromReply`).
 * - Base UI's menu carries the keys, as every Inbox menu's: Enter, Space or ↓ opens it on its first row; ↑ ↓ Home
 *   End and type-ahead move; Escape or Tab closes it and focus goes back to +. No shortcut of its own.
 * - The + turns into × while the menu is open; the menu rises and fades in (none of it with reduced motion).
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import { Icon } from '../icons';
import { Tip } from '../components/Tip';

/** A phone's picker offers the photo library and Files (compose/ComposeFiles.tsx, the paperclip's). */
const PHONE_ACCEPT = 'image/*,*/*';

export function ReplyPlusMenu({
  phone,
  iconSize,
  onFiles,
  onCanvas,
  inputData = 'data-reply-attach',
}: {
  phone: boolean;
  iconSize: number;
  /** What the picker chose (the input is emptied after, so the same file can be picked again). */
  onFiles: (files: FileList) => void;
  /** The thread's canvas; null where it can have none (the menu then holds Attach a file alone). */
  onCanvas: (() => void) | null;
  /** A `data-*` attribute for the file input, for tests and the page's own lookups. */
  inputData?: string;
}) {
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // Drawn inside the window's root, so its styles and theme reach the menu (CopyMenus.tsx `usePortal`).
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const root = trigger.current?.closest<HTMLElement>('.pn-inbox');
    if (root && root !== portal) setPortal(root);
  });
  return (
    <>
      <Menu.Root open={open} onOpenChange={setOpen} modal={false}>
        <Tip content="Add" when={() => !open}>
          <Menu.Trigger ref={trigger} className="ib-ricon ib-rplus" aria-label="Add" data-reply-plus="" data-open={open ? '' : undefined}>
            <Icon name="plus" size={iconSize} />
          </Menu.Trigger>
        </Tip>
        <Menu.Portal container={portal ?? undefined}>
          <Menu.Positioner className="ib-pm-pos ib-rplus-pos" side="top" align="start" sideOffset={6} data-rplus-phone={phone ? '' : undefined}>
            <Menu.Popup className="ib-pm ib-rplus-pm" aria-label="Add to the reply" data-reply-plus-menu="">
              <Menu.Item className="ib-pmi" label="Attach a file" onClick={() => input.current?.click()} data-reply-plus-item="attach">
                <Icon name="clip" size={15} />
                Attach a file
              </Menu.Item>
              {onCanvas && (
                <Menu.Item className="ib-pmi" label="Canvas" onClick={onCanvas} data-reply-plus-item="canvas">
                  <Icon name="diagram" size={15} />
                  Canvas
                </Menu.Item>
              )}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <input
        ref={input}
        type="file"
        multiple
        className="ib-sr"
        tabIndex={-1}
        aria-hidden="true"
        accept={phone ? PHONE_ACCEPT : undefined}
        {...{ [inputData]: '' }}
        onChange={(event) => {
          if (event.target.files && event.target.files.length > 0) onFiles(event.target.files);
          event.target.value = '';
        }}
      />
    </>
  );
}
