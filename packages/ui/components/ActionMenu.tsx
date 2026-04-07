import React, { useEffect, useRef, useState } from 'react';

interface ActionMenuProps {
  className?: string;
  panelClassName?: string;
  renderTrigger: (props: {
    isOpen: boolean;
    toggleMenu: () => void;
  }) => React.ReactNode;
  children: (props: { closeMenu: () => void }) => React.ReactNode;
}

export const ActionMenu: React.FC<ActionMenuProps> = ({
  className,
  panelClassName,
  renderTrigger,
  children,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div ref={menuRef} className={className ? `relative ${className}` : 'relative'}>
      {renderTrigger({
        isOpen,
        toggleMenu: () => setIsOpen(open => !open),
      })}

      {isOpen && (
        <div className={panelClassName ?? 'absolute top-full right-0 mt-1 w-56 rounded-lg border border-border bg-popover py-1 shadow-xl z-[70]'}>
          {children({ closeMenu: () => setIsOpen(false) })}
        </div>
      )}
    </div>
  );
};

interface ActionMenuItemProps {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  subtitle?: string;
  badge?: React.ReactNode;
}

export const ActionMenuItem: React.FC<ActionMenuItemProps> = ({
  onClick,
  icon,
  label,
  subtitle,
  badge,
}) => (
  <button
    onClick={onClick}
    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-muted"
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
