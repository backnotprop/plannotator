import React, { useState, useRef, useEffect } from 'react';
import { useTheme } from './ThemeProvider';

interface MobileMenuProps {
  isPanelOpen: boolean;
  onTogglePanel: () => void;
  annotationCount: number;
  onOpenExport: () => void;
  onOpenSettings: () => void;
  onDownloadAnnotations: () => void;
  onCopyShareLink: () => void;
  onOpenImport: () => void;
  shareUrl?: string;
  sharingEnabled: boolean;
  className?: string;
}

export const MobileMenu: React.FC<MobileMenuProps> = ({
  isPanelOpen,
  onTogglePanel,
  annotationCount,
  onOpenExport,
  onOpenSettings,
  onDownloadAnnotations,
  onCopyShareLink,
  onOpenImport,
  sharingEnabled,
  className,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('pointerdown', handleClickOutside);
    return () => document.removeEventListener('pointerdown', handleClickOutside);
  }, [isOpen]);

  const handleAction = (action: () => void) => {
    setIsOpen(false);
    action();
  };

  return (
    <div className={`relative ${className ?? ''}`} ref={menuRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        title="Menu"
      >
        {isOpen ? (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        ) : (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        )}
      </button>

      {isOpen && (
        <div className="absolute top-full right-0 mt-1 w-56 bg-popover border border-border rounded-lg shadow-xl z-[70] py-1">
          {/* Theme toggle */}
          <div className="px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Theme</div>
            <div className="flex items-center gap-1 bg-muted/50 rounded-lg p-0.5">
              {(['light', 'dark', 'system'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTheme(t)}
                  className={`flex-1 px-2 py-1 text-[10px] capitalize rounded-md transition-colors ${
                    theme === t
                      ? 'bg-background text-foreground shadow-sm font-medium'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="my-1 border-t border-border" />

          {/* Settings */}
          <MenuItem
            onClick={() => handleAction(onOpenSettings)}
            icon={<SettingsIcon />}
            label="Settings"
          />

          {/* Annotations panel toggle */}
          <MenuItem
            onClick={() => handleAction(onTogglePanel)}
            icon={<AnnotationsIcon />}
            label={isPanelOpen ? 'Hide Annotations' : 'Show Annotations'}
            badge={annotationCount > 0 ? annotationCount : undefined}
          />

          <div className="my-1 border-t border-border" />

          {/* Export */}
          <MenuItem
            onClick={() => handleAction(onOpenExport)}
            icon={<ExportIcon />}
            label="Export"
          />

          {/* Download */}
          <MenuItem
            onClick={() => handleAction(onDownloadAnnotations)}
            icon={<DownloadIcon />}
            label="Download Annotations"
          />

          {/* Share link */}
          {sharingEnabled && (
            <MenuItem
              onClick={() => handleAction(onCopyShareLink)}
              icon={<LinkIcon />}
              label="Copy Share Link"
            />
          )}

          {/* Import */}
          {sharingEnabled && (
            <>
              <div className="my-1 border-t border-border" />
              <MenuItem
                onClick={() => handleAction(onOpenImport)}
                icon={<ImportIcon />}
                label="Import Review"
              />
            </>
          )}
        </div>
      )}
    </div>
  );
};

const MenuItem: React.FC<{
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: number;
}> = ({ onClick, icon, label, badge }) => (
  <button
    onClick={onClick}
    className="w-full text-left px-3 py-2 text-xs hover:bg-muted transition-colors flex items-center gap-2"
  >
    <span className="text-muted-foreground">{icon}</span>
    <span className="flex-1">{label}</span>
    {badge !== undefined && (
      <span className="text-[10px] font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
        {badge}
      </span>
    )}
  </button>
);

// Icons
const SettingsIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);

const AnnotationsIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
  </svg>
);

const ExportIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
  </svg>
);

const DownloadIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
  </svg>
);

const LinkIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
  </svg>
);

const ImportIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3" />
  </svg>
);
