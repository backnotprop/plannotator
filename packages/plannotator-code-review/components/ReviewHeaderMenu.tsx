import React, { useMemo } from 'react';
import {
  ActionMenu,
  ActionMenuDivider,
  ActionMenuItem,
  ActionMenuSectionLabel,
} from '@plannotator/ui/components/ActionMenu';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { modKey } from '@plannotator/ui/utils/platform';

interface ReviewHeaderMenuProps {
  onOpenSettings: () => void;
  onOpenExport: () => void;
  onToggleFileTree: () => void;
  onToggleSidebar: () => void;
  isFileTreeOpen: boolean;
  isSidebarOpen: boolean;
  appVersion: string;
}

export const ReviewHeaderMenu: React.FC<ReviewHeaderMenuProps> = ({
  onOpenSettings,
  onOpenExport,
  onToggleFileTree,
  onToggleSidebar,
  isFileTreeOpen,
  isSidebarOpen,
  appVersion,
}) => {
  const { theme, resolvedMode, setTheme } = useTheme();
  const activeTheme = useMemo<'light' | 'dark'>(() => {
    return theme === 'system' ? resolvedMode : theme;
  }, [resolvedMode, theme]);

  return (
    <ActionMenu
      renderTrigger={({ isOpen, toggleMenu }) => (
        <button
          onClick={toggleMenu}
          className={`flex items-center gap-1.5 p-1.5 md:px-2.5 md:py-1 rounded-md text-xs font-medium transition-colors ${
            isOpen
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted'
          }`}
          title="Options"
          aria-label="Options"
          aria-expanded={isOpen}
        >
          {isOpen ? <CloseIcon /> : <MenuIcon />}
          <span className="hidden md:inline">Options</span>
        </button>
      )}
    >
      {({ closeMenu }) => (
        <>
          <div className="px-3 py-2 space-y-1.5">
            <ActionMenuSectionLabel>Theme</ActionMenuSectionLabel>
            <div className="flex items-center gap-1 rounded-lg bg-muted/50 p-0.5">
              {(['light', 'dark'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => {
                    closeMenu();
                    setTheme(mode);
                  }}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                    activeTheme === mode
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {mode === 'light' ? <SunIcon /> : <MoonIcon />}
                  <span className="capitalize">{mode}</span>
                </button>
              ))}
            </div>
          </div>

          <ActionMenuDivider />

          <ActionMenuItem
            onClick={() => {
              closeMenu();
              onOpenSettings();
            }}
            icon={<SettingsIcon />}
            label="Settings"
          />
          <ActionMenuItem
            onClick={() => {
              closeMenu();
              onOpenExport();
            }}
            icon={<ExportIcon />}
            label="Export"
          />

          <ActionMenuDivider />

          <ActionMenuItem
            onClick={() => {
              closeMenu();
              onToggleFileTree();
            }}
            icon={<FileTreeMenuIcon />}
            label={isFileTreeOpen ? 'Hide File Tree' : 'Show File Tree'}
            badge={<KbdHint keys={[modKey, 'B']} />}
          />
          <ActionMenuItem
            onClick={() => {
              closeMenu();
              onToggleSidebar();
            }}
            icon={<SidebarIcon />}
            label={isSidebarOpen ? 'Hide Sidebar' : 'Show Sidebar'}
            badge={<KbdHint keys={[modKey, '.']} />}
          />

          <ActionMenuDivider />

          <div className="px-3 py-2 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <ActionMenuSectionLabel>Plannotator</ActionMenuSectionLabel>
              <span className="text-[10px] font-mono text-muted-foreground/70">
                v{appVersion}
              </span>
            </div>
            <div className="flex flex-col items-start gap-1 text-[11px]">
              <a
                href="https://github.com/backnotprop/plannotator/releases"
                target="_blank"
                rel="noopener noreferrer"
                onClick={closeMenu}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                Release notes
              </a>
              <a
                href="https://github.com/backnotprop/plannotator"
                target="_blank"
                rel="noopener noreferrer"
                onClick={closeMenu}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                Project repo
              </a>
            </div>
          </div>
        </>
      )}
    </ActionMenu>
  );
};

const MenuIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
  </svg>
);

const CloseIcon = () => (
  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
  </svg>
);

const SettingsIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);


const ExportIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
  </svg>
);

const SunIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25M12 18.75V21M3 12h2.25M18.75 12H21M5.636 5.636l1.591 1.591M16.773 16.773l1.591 1.591M5.636 18.364l1.591-1.591M16.773 7.227l1.591-1.591" />
    <circle cx="12" cy="12" r="3.25" />
  </svg>
);

const MoonIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M21 12.79A9 9 0 1111.21 3c-.18.57-.21 1.19-.21 1.82A8 8 0 0019.18 13c.63 0 1.25-.03 1.82-.21z" />
  </svg>
);

const FileTreeMenuIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
  </svg>
);

const KbdHint: React.FC<{ keys: string[] }> = ({ keys }) => (
  <span className="inline-flex items-center gap-0.5 ml-auto">
    {keys.map((k, i) => (
      <kbd key={i} className="inline-flex items-center justify-center h-[18px] min-w-[18px] px-1 rounded bg-muted border border-border/60 text-[10px] font-mono leading-none text-muted-foreground">
        {k}
      </kbd>
    ))}
  </span>
);

const SidebarIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M9 4h10a2 2 0 012 2v12a2 2 0 01-2 2H9M9 4H5a2 2 0 00-2 2v12a2 2 0 002 2h4M9 4v16" />
  </svg>
);
