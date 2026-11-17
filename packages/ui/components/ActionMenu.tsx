import React, { useCallback, useId, useRef, useState } from 'react';
import { useDismissablePopover } from '../hooks/useDismissablePopover';
import { useEdgeSwipe } from '../hooks/useEdgeSwipe';
import { usePanelScrollLock } from '../hooks/usePanelScrollLock';

interface ActionMenuProps {
  className?: string;
  panelClassName?: string;
  panelWidth?: 'default' | 'wide';
  /** Allow a swipe from inside the open compact Options menu to dismiss it. */
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
  const menuRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const selector = `[data-pn-options-menu="${panelId}"]`;
  usePanelScrollLock(compactEdgeSwipe && isOpen);
  const dismiss = useCallback(() => setIsOpen(false), []);
  useEdgeSwipe({
    enabled: compactEdgeSwipe,
    panel: isOpen ? { side: 'right', selector, onClose: dismiss } : undefined,
  });
  useDismissablePopover({
    enabled: isOpen,
    ref: menuRef,
    onDismiss: dismiss,
  });

  const panel = isOpen ? (
    <div
      data-pn-dismissable-popover="true"
      data-pn-options-menu={compactEdgeSwipe ? panelId : undefined}
      data-pn-compact-touch-layout={compactEdgeSwipe ? 'true' : undefined}
      role={compactEdgeSwipe ? 'dialog' : undefined}
      aria-label={compactEdgeSwipe ? 'Options' : undefined}
      data-pn-panel-side={compactEdgeSwipe ? 'right' : undefined}
      className={compactEdgeSwipe
          ? 'absolute top-full right-0 mt-1 w-[min(18rem,calc(100vw-1rem))] max-h-[calc(var(--pn-viewport-height,100vh)-4.5rem-var(--pn-safe-top)-var(--pn-safe-bottom))] overflow-y-auto rounded-lg border border-border bg-popover py-1 shadow-xl z-[70]'
          : panelClassName ?? `absolute top-full right-0 mt-1 ${panelWidth === 'wide' ? 'w-64' : 'w-56'} rounded-lg border border-border bg-popover py-1 shadow-xl z-[70]`}
    >
      {children({ closeMenu: dismiss })}
    </div>
  ) : null;

  return (
    <div ref={menuRef} className={className ? `relative ${className}` : 'relative'}>
      {renderTrigger({ isOpen, toggleMenu: () => setIsOpen(open => !open) })}
      {panel}
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
