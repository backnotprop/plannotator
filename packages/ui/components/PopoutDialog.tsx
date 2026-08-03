import React, { useCallback } from 'react';
import { Dialog } from '@base-ui/react/dialog';

const ANNOTATION_SELECTORS = [
  '.annotation-toolbar',
  '[data-comment-popover="true"]',
  '[data-floating-picker="true"]',
];

interface PopoutDialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  container?: HTMLElement | null;
  className?: string;
  children: React.ReactNode;
  /** Extra data attributes to spread onto the dialog popup */
  dataAttributes?: Record<string, string>;
}

export const PopoutDialog: React.FC<PopoutDialogProps> = ({
  open,
  onClose,
  title,
  container,
  className,
  children,
  dataAttributes,
}) => {
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as Element;
      if (ANNOTATION_SELECTORS.some((sel) => target.closest(sel))) return;
      onClose();
    },
    [onClose],
  );

  const handleOpenChange = useCallback(
    (next: boolean, eventDetails: Dialog.Root.ChangeEventDetails) => {
      if (next) return;
      // Interactions with annotation UI (toolbars/popovers portal outside the
      // dialog) must not dismiss the popout — the Radix version guarded this
      // via onInteractOutside preventDefault; Base UI expresses it as
      // cancelling the outside-press/focus-out close reason.
      if (eventDetails.reason === 'outside-press' || eventDetails.reason === 'focus-out') {
        // For focus events the annotation UI may sit on either side of the
        // event (target = element losing focus, relatedTarget = gaining), so
        // guard both.
        const event = eventDetails.event as Event | undefined;
        const candidates = [
          event?.target as Element | null,
          (event as FocusEvent | undefined)?.relatedTarget as Element | null,
        ];
        if (
          candidates.some(
            (el) => el instanceof Element && ANNOTATION_SELECTORS.some((sel) => el.closest(sel)),
          )
        ) {
          eventDetails.cancel();
          return;
        }
      }
      onClose();
    },
    [onClose],
  );

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange} modal={false}>
      <Dialog.Portal container={container ?? undefined}>
        {/* Non-modal dialogs render no library backdrop, so we use a plain
            div for the dark scrim + blur while keeping annotation toolbars
            (which portal outside the dialog) interactive. */}
        <div
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px]"
          onClick={handleBackdropClick}
          aria-hidden="true"
        />
        <Dialog.Popup
          className={`fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 bg-background border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden ${className ?? 'w-[calc(100vw-4rem)] max-w-[min(calc(100vw-4rem),1500px)] max-h-[calc(100vh-4rem)]'}`}
          data-popout="true"
          initialFocus={false}
          {...dataAttributes}
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          <Dialog.Close
            render={
              <button
                className="absolute top-3 right-3 z-20 p-1.5 rounded-md text-muted-foreground/70 hover:bg-muted hover:text-foreground transition-colors"
                aria-label="Close"
              />
            }
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </Dialog.Close>

          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
