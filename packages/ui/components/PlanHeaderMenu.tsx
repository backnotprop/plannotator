import React from 'react';
import {
  ActionMenu,
  ActionMenuDivider,
  ActionMenuItem,
  ActionMenuSectionLabel,
} from './ActionMenu';
import { useTheme } from './ThemeProvider';
import { SunIcon, MoonIcon, SystemIcon } from './icons/themeIcons';
import { ReviewAgentsIcon } from './ReviewAgentsIcon';

interface PlanHeaderMenuProps {
  appVersion: string;
  onOpenSettings: () => void;
  onOpenExport: () => void;
  onCopyAgentInstructions: () => void;
  onDownloadAnnotations: () => void;
  onPrint: () => void;
  onCopyShareLink: () => void;
  onOpenImport: () => void;
  onSaveToObsidian: () => void;
  onSaveToBear: () => void;
  onSaveToOctarine: () => void;
  sharingEnabled: boolean;
  isApiMode: boolean;
  agentInstructionsEnabled: boolean;
  hasNewSettingsHints: boolean;
  obsidianConfigured: boolean;
  bearConfigured: boolean;
  octarineConfigured: boolean;
}

export const PlanHeaderMenu: React.FC<PlanHeaderMenuProps> = ({
  appVersion,
  onOpenSettings,
  onOpenExport,
  onCopyAgentInstructions,
  onDownloadAnnotations,
  onPrint,
  onCopyShareLink,
  onOpenImport,
  onSaveToObsidian,
  onSaveToBear,
  onSaveToOctarine,
  sharingEnabled,
  isApiMode,
  agentInstructionsEnabled,
  hasNewSettingsHints,
  obsidianConfigured,
  bearConfigured,
  octarineConfigured,
}) => {
  const { theme, setTheme } = useTheme();

  const anyNotesAppConfigured =
    isApiMode && (obsidianConfigured || bearConfigured || octarineConfigured);

  return (
    <ActionMenu
      renderTrigger={({ isOpen, toggleMenu }) => (
        <button
          onClick={toggleMenu}
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
          <span className="hidden md:inline">Options</span>
          {hasNewSettingsHints && !isOpen && (
            <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
              <span className="absolute inset-0 rounded-full bg-primary opacity-75 animate-ping" />
              <span className="relative rounded-full h-2 w-2 bg-primary" />
            </span>
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
          {agentInstructionsEnabled && (
            <ActionMenuItem
              onClick={() => {
                closeMenu();
                onCopyAgentInstructions();
              }}
              icon={<ReviewAgentsIcon />}
              label="Agent Instructions"
              subtitle="Copy agent instructions for external annotations"
            />
          )}

          <ActionMenuDivider />

          <ActionMenuItem
            onClick={() => {
              closeMenu();
              onDownloadAnnotations();
            }}
            icon={<DownloadIcon />}
            label="Download Annotations"
          />
          <ActionMenuItem
            onClick={() => {
              closeMenu();
              onPrint();
            }}
            icon={<PrintIcon />}
            label="Print / Save as PDF"
            subtitle="Choose 'Save as PDF' in the print dialog"
          />
          {sharingEnabled && (
            <ActionMenuItem
              onClick={() => {
                closeMenu();
                onCopyShareLink();
              }}
              icon={<LinkIcon />}
              label="Copy Share Link"
            />
          )}
          {sharingEnabled && (
            <ActionMenuItem
              onClick={() => {
                closeMenu();
                onOpenImport();
              }}
              icon={<ImportIcon />}
              label="Import Review"
            />
          )}

          {anyNotesAppConfigured && (
            <>
              <ActionMenuDivider />
              {obsidianConfigured && (
                <ActionMenuItem
                  onClick={() => {
                    closeMenu();
                    onSaveToObsidian();
                  }}
                  icon={<NoteIcon />}
                  label="Save to Obsidian"
                />
              )}
              {bearConfigured && (
                <ActionMenuItem
                  onClick={() => {
                    closeMenu();
                    onSaveToBear();
                  }}
                  icon={<NoteIcon />}
                  label="Save to Bear"
                />
              )}
              {octarineConfigured && (
                <ActionMenuItem
                  onClick={() => {
                    closeMenu();
                    onSaveToOctarine();
                  }}
                  icon={<NoteIcon />}
                  label="Save to Octarine"
                />
              )}
            </>
          )}

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

const DownloadIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
  </svg>
);

const PrintIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
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

const NoteIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
  </svg>
);

