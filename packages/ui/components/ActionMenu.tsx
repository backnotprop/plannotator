import React, { useCallback, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDismissablePopover } from '../hooks/useDismissablePopover';
import { useEdgeSwipe } from '../hooks/useEdgeSwipe';
import { usePanelPresence } from '../hooks/usePanelPresence';
import { usePanelScrollLock } from '../hooks/usePanelScrollLock';
import { usePanelDrag } from '../hooks/usePanelDrag';

interface ActionMenuProps {
  className?: string;
  panelClassName?: string;
  panelWidth?: 'default' | 'wide';
  /** Let the compact header's Options menu own the right-edge gesture. */
  compactEdgeSwipe?: boolean;
  renderTrigger: (props: {
    isOpen: boolean;
    toggleMenu: () => void;
  }) => React.ReactNode;
  children: (props: { closeMenu: () => void }) => React.ReactNode;
}

export const ActionMenu: React.FC<ActionMenuProps> = ({
  className,
  panelClassName,
  panelWidth = 'default',
  compactEdgeSwipe = false,
  renderTrigger,
  children,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [presentation, setPresentation] = useState<'popover' | 'drawer'>('popover');
  const drawer = compactEdgeSwipe && presentation === 'drawer';
  const menuRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const selector = `[data-pn-options-menu="${panelId}"]`;
  const panelDrag = usePanelDrag({
    selector,
    onPreview: () => setPresentation('drawer'),
    onOpen: () => setIsOpen(true),
    onClose: () => setIsOpen(false),
    fallbackWidth: () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      return Math.min(18 * rem, window.visualViewport?.width || window.innerWidth);
    },
  });
  const previewing = drawer && panelDrag.active && !isOpen;
  const presence = usePanelPresence(isOpen || previewing, drawer);
  usePanelScrollLock(compactEdgeSwipe && presence.present);

  const cancelDrag = panelDrag.cancel;
  const dismiss = useCallback(() => { cancelDrag(); setIsOpen(false); }, [cancelDrag]);
  useEdgeSwipe({
    enabled: compactEdgeSwipe,
    onOpenRight: () => { setPresentation('drawer'); setIsOpen(true); },
    drag: { right: panelDrag.gesture },
    panel: isOpen ? { side: 'right', selector, onClose: dismiss, trackDrag: drawer } : undefined,
  });
  useDismissablePopover({
    enabled: isOpen,
    ref: menuRef,
    contentRef: panelRef,
    onDismiss: dismiss,
  });

  const panel = presence.present ? (
    <div
      ref={panelRef}
      data-pn-dismissable-popover="true"
      data-pn-options-menu={compactEdgeSwipe ? panelId : undefined}
      data-print-hide={drawer || undefined}
      data-pn-compact-touch-layout={compactEdgeSwipe ? 'true' : undefined}
      role={compactEdgeSwipe ? 'dialog' : undefined}
      aria-label={compactEdgeSwipe ? 'Options' : undefined}
      aria-hidden={(presence.closing || previewing) || undefined}
      inert={(presence.closing || previewing) || undefined}
      data-pn-panel-side={compactEdgeSwipe ? 'right' : undefined}
      data-pn-panel-state={drawer ? (presence.closing ? 'closed' : 'open') : undefined}
      className={drawer
        ? 'pn-options-drawer flex flex-col border-l border-border bg-popover text-foreground shadow-xl z-[70]'
        : compactEdgeSwipe
          ? 'absolute top-full right-0 mt-1 w-[min(18rem,calc(100vw-1rem))] max-h-[calc(var(--pn-viewport-height,100vh)-4.5rem-var(--pn-safe-top)-var(--pn-safe-bottom))] overflow-y-auto rounded-lg border border-border bg-popover py-1 shadow-xl z-[70]'
          : panelClassName ?? `absolute top-full right-0 mt-1 ${panelWidth === 'wide' ? 'w-64' : 'w-56'} rounded-lg border border-border bg-popover py-1 shadow-xl z-[70]`}
    >
      {drawer && (
        <div className="flex h-[52px] shrink-0 items-center justify-between border-b border-border/50 px-3">
          <h2 className="text-sm font-semibold">Options</h2>
          <button
            type="button"
            data-pn-touch-target
            data-pn-touch-target-icon
            aria-label="Close options"
            onClick={dismiss}
            className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
      )}
      {compactEdgeSwipe
        ? <div data-pn-options-content className={drawer ? "min-h-0 flex-1 overflow-y-auto overscroll-contain py-1" : undefined}>{children({ closeMenu: dismiss })}</div>
        : children({ closeMenu: dismiss })}
    </div>
  ) : null;

  return (
    <div ref={menuRef} className={className ? `relative ${className}` : 'relative'}>
      {renderTrigger({ isOpen, toggleMenu: () => {
        if (!isOpen) setPresentation('popover');
        setIsOpen(open => !open);
      } })}
      {drawer && panel ? createPortal(panel, document.body) : panel}
    </div>
  );
};

interface ActionMenuItemProps {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  subtitle?: string;
  badge?: React.ReactNode;
  disabled?: boolean;
  /** ARIA menu semantics for hosts that render a real `role="menu"` popover
   *  (DecisionControl). Default undefined so existing consumers are unchanged. */
  role?: 'menuitem';
  /** Appended to the row's classes (e.g. a tone token). Default undefined so
   *  existing consumers are byte-identical. */
  className?: string;
}

export const ActionMenuItem: React.FC<ActionMenuItemProps> = ({
  onClick,
  icon,
  label,
  subtitle,
  badge,
  disabled = false,
  role,
  className,
}) => (
  <button
    data-pn-touch-target
    type="button"
    onClick={onClick}
    disabled={disabled}
    role={role}
    className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent${className ? ` ${className}` : ''}`}
  >
    <span className="text-muted-foreground">{icon}</span>
    {subtitle ? (
      <span className="flex flex-1 flex-col gap-0.5">
        <span>{label}</span>
        <span className="text-[10px] text-muted-foreground">{subtitle}</span>
      </span>
    ) : (
      <span className="flex-1">{label}</span>
    )}
    {badge}
  </button>
);

export const ActionMenuDivider: React.FC = () => (
  <div className="my-1 border-t border-border" />
);

export const ActionMenuSectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
    {children}
  </div>
);
