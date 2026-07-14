import React from 'react';
import {
  ActionMenu,
  ActionMenuDivider,
  ActionMenuItem,
  ActionMenuSectionLabel,
} from '@plannotator/ui/components/ActionMenu';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { SunIcon, MoonIcon, SystemIcon } from '@plannotator/ui/components/icons/themeIcons';
import { MenuVersionSection } from '@plannotator/ui/components/MenuVersionSection';
import { TextShimmer } from '@plannotator/ui/components/TextShimmer';
import { modKey } from '@plannotator/ui/utils/platform';
import type { UpdateInfo } from '@plannotator/ui/hooks/useUpdateCheck';
import type { Origin } from '@plannotator/shared/agents';

interface ReviewHeaderMenuProps {
  onOpenSettings: () => void;
  onOpenExport: () => void;
  onToggleFileTree: () => void;
  onToggleSidebar: () => void;
  isFileTreeOpen: boolean;
  isSidebarOpen: boolean;
  appVersion: string;
  updateInfo?: UpdateInfo | null;
  origin?: Origin | null;
  isWSL?: boolean;
}

export const ReviewHeaderMenu: React.FC<ReviewHeaderMenuProps> = ({
  onOpenSettings,
  onOpenExport,
  onToggleFileTree,
  onToggleSidebar,
  isFileTreeOpen,
  isSidebarOpen,
  appVersion,
  updateInfo,
  origin,
  isWSL = false,
}) => {
  const { theme, setTheme } = useTheme();

  const showUpdateDot = !!updateInfo?.updateAvailable && !updateInfo.dismissed;

  return (
    <ActionMenu
      renderTrigger={({ isOpen, toggleMenu }) => (
        <button
          onClick={() => {
            if (!isOpen && showUpdateDot) updateInfo?.dismiss();
            toggleMenu();
          }}
          className={`relative flex items-center gap-1.5 p-1.5 md:px-2.5 md:py-1 rounded-md text-xs font-medium transition-colors ${
            isOpen
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted'
          }`}
          title="Options"
          aria-label="Options"
          aria-expanded={isOpen}
        >
          {isOpen ? <CloseIcon /> : <MenuIcon />}
          {showUpdateDot ? (
            <TextShimmer className="hidden md:inline text-xs font-medium" duration={2.5} spread={1.5}>
              Options
            </TextShimmer>
          ) : (
            <span className="hidden md:inline">Options</span>
          )}
          {showUpdateDot && (
            <span className="absolute top-0.5 right-0.5 md:-top-0.5 md:-right-0.5 w-2 h-2 rounded-full bg-primary ring-2 ring-background" />
          )}
        </button>
      )}
    >
      {({ closeMenu }) => (
        <>
          <div className="px-3 py-2 space-y-1.5">
            <ActionMenuSectionLabel>Theme</ActionMenuSectionLabel>
            <div className="flex items-center gap-1 rounded-lg bg-muted/50 p-0.5">
              {(['light', 'dark', 'system'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => {
                    closeMenu();
                    setTheme(mode);
                  }}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                    theme === mode
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {mode === 'light' ? <SunIcon /> : mode === 'dark' ? <MoonIcon /> : <SystemIcon />}
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

          <MenuVersionSection
            appVersion={appVersion}
            updateInfo={updateInfo}
            origin={origin}
            isWSL={isWSL}
            closeMenu={closeMenu}
          />
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
