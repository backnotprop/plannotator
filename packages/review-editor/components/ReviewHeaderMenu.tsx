import React from 'react';
import {
  ActionMenu,
  ActionMenuDivider,
  ActionMenuItem,
  ActionMenuSectionLabel,
} from '@plannotator/ui/components/ActionMenu';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { THEME_MODES } from '@plannotator/ui/components/themeModes';
import { MenuVersionSection } from '@plannotator/ui/components/MenuVersionSection';
import { ReviewAgentsIcon } from '@plannotator/ui/components/ReviewAgentsIcon';
import { TextShimmer } from '@plannotator/ui/components/TextShimmer';
import { SparklesIcon } from '@plannotator/ui/components/SparklesIcon';
import { GitHubIcon } from '@plannotator/ui/components/GitHubIcon';
import { GitLabIcon } from '@plannotator/ui/components/GitLabIcon';
import { modKey } from '@plannotator/ui/utils/platform';
import type { UpdateInfo } from '@plannotator/ui/hooks/useUpdateCheck';
import type { Origin } from '@plannotator/shared/agents';

export interface CompactReviewDestination {
  value: 'agent' | 'platform';
  platform: 'github' | 'gitlab';
  platformLabel: string;
  onChange: (value: 'agent' | 'platform') => void;
}

export interface CompactReviewAction {
  id: 'exit' | 'feedback' | 'approve' | 'copy';
  label: string;
  subtitle?: string;
  onSelect: () => void;
  disabled?: boolean;
}

interface ReviewHeaderMenuProps {
  onOpenSettings: () => void;
  onOpenReviewSetup?: () => void;
  onOpenExport: () => void;
  onCopyAgentInstructions: () => void;
  onToggleFileTree: () => void;
  onToggleSidebar: () => void;
  onOpenGuide?: () => void;
  onOpenAnnotations?: () => void;
  onOpenAI?: () => void;
  onOpenAgents?: () => void;
  compactDestination?: CompactReviewDestination;
  compactActions?: CompactReviewAction[];
  isFileTreeOpen: boolean;
  isSidebarOpen: boolean;
  compactTouchLayout?: boolean;
  agentInstructionsEnabled: boolean;
  appVersion: string;
  updateInfo?: UpdateInfo | null;
  origin?: Origin | null;
  isWSL?: boolean;
}

export const ReviewHeaderMenu: React.FC<ReviewHeaderMenuProps> = ({
  onOpenSettings,
  onOpenReviewSetup,
  onOpenExport,
  onCopyAgentInstructions,
  onToggleFileTree,
  onToggleSidebar,
  onOpenGuide,
  onOpenAnnotations,
  onOpenAI,
  onOpenAgents,
  compactDestination,
  compactActions = [],
  isFileTreeOpen,
  isSidebarOpen,
  compactTouchLayout = false,
  agentInstructionsEnabled,
  appVersion,
  updateInfo,
  origin,
  isWSL = false,
}) => {
  const { theme, setTheme } = useTheme();

  const showUpdateDot = !!updateInfo?.updateAvailable && !updateInfo.dismissed;

  return (
    <ActionMenu
      panelWidth="wide"
      panelClassName={compactTouchLayout
        ? 'absolute top-full right-0 mt-1 w-[min(18rem,calc(100vw-1rem))] max-h-[calc(var(--pn-viewport-height,100vh)-4.5rem-var(--pn-safe-top)-var(--pn-safe-bottom))] overflow-y-auto rounded-lg border border-border bg-popover py-1 shadow-xl z-[70]'
        : undefined
      }
      renderTrigger={({ isOpen, toggleMenu }) => (
        <button
          data-pn-touch-target
          data-pn-touch-target-icon
          onClick={() => {
            if (!isOpen && showUpdateDot) updateInfo?.dismiss();
            toggleMenu();
          }}
          className={`relative flex h-7 items-center gap-1.5 px-1.5 lg:px-2.5 rounded-md text-xs font-medium transition-colors ${
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
            <TextShimmer className="hidden lg:inline text-xs font-medium" duration={2.5} spread={1.5}>
              Options
            </TextShimmer>
          ) : (
            <span className="hidden lg:inline">Options</span>
          )}
          {showUpdateDot && (
            <span className="absolute top-0.5 right-0.5 lg:-top-0.5 lg:-right-0.5 w-2 h-2 rounded-full bg-primary ring-2 ring-background" />
          )}
        </button>
      )}
    >
      {({ closeMenu }) => (
        <>
          {compactTouchLayout && (compactDestination || compactActions.length > 0) && (
            <>
              <div className="px-3 py-2 space-y-2">
                <ActionMenuSectionLabel>Review</ActionMenuSectionLabel>
                {compactDestination && (
                  <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted/50 p-0.5" aria-label="Review destination">
                    {(['agent', 'platform'] as const).map((destination) => {
                      const selected = compactDestination.value === destination;
                      const label = destination === 'agent' ? 'Agent' : compactDestination.platformLabel;
                      return (
                        <button
                          data-pn-touch-target
                          type="button"
                          key={destination}
                          aria-pressed={selected}
                          onClick={() => compactDestination.onChange(destination)}
                          className={`flex min-w-0 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                            selected
                              ? 'bg-background text-foreground shadow-sm'
                              : 'text-muted-foreground hover:text-foreground'
                          }`}
                        >
                          {destination === 'platform'
                            ? compactDestination.platform === 'gitlab'
                              ? <GitLabIcon className="w-3.5 h-3.5" />
                              : <GitHubIcon className="w-3.5 h-3.5" />
                            : <AgentDestinationIcon />
                          }
                          <span className="truncate">{label}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              {compactActions.map((action) => (
                <ActionMenuItem
                  key={action.id}
                  onClick={() => {
                    closeMenu();
                    action.onSelect();
                  }}
                  disabled={action.disabled}
                  icon={<CompactReviewActionIcon kind={action.id} />}
                  label={action.label}
                  subtitle={action.subtitle}
                />
              ))}
              <ActionMenuDivider />
            </>
          )}

          <div className="px-3 py-2 space-y-1.5">
            <ActionMenuSectionLabel>Theme</ActionMenuSectionLabel>
            <div className="flex items-center gap-1 rounded-lg bg-muted/50 p-0.5">
              {THEME_MODES.map(({ id, label, Icon }) => (
                <button
                  data-pn-touch-target={compactTouchLayout || undefined}
                  key={id}
                  onClick={() => {
                    closeMenu();
                    setTheme(id);
                  }}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                    theme === id
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Icon />
                  <span>{label}</span>
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
          {onOpenReviewSetup && (
            <ActionMenuItem
              onClick={() => {
                closeMenu();
                onOpenReviewSetup();
              }}
              icon={(
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 5h16M4 10h16M4 15h16M4 20h10" />
                </svg>
              )}
              label="Set up review view"
            />
          )}
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
              subtitle="Copy agent instructions for external review comments"
            />
          )}

          {(onOpenGuide || onOpenAnnotations || onOpenAI || onOpenAgents) && (
            <>
              <ActionMenuDivider />
              {onOpenGuide && (
                <ActionMenuItem
                  onClick={() => {
                    closeMenu();
                    onOpenGuide();
                  }}
                  icon={<GuideIcon />}
                  label="Guided Review"
                />
              )}
              {onOpenAnnotations && (
                <ActionMenuItem
                  onClick={() => {
                    closeMenu();
                    onOpenAnnotations();
                  }}
                  icon={<SidebarIcon />}
                  label="Annotations"
                />
              )}
              {onOpenAI && (
                <ActionMenuItem
                  onClick={() => {
                    closeMenu();
                    onOpenAI();
                  }}
                  icon={<SparklesIcon className="w-3.5 h-3.5" />}
                  label="AI Chat"
                />
              )}
              {onOpenAgents && (
                <ActionMenuItem
                  onClick={() => {
                    closeMenu();
                    onOpenAgents();
                  }}
                  icon={<ReviewAgentsIcon className="w-3.5 h-3.5" />}
                  label="Review Agents"
                />
              )}
            </>
          )}

          <ActionMenuDivider />

          <ActionMenuItem
            onClick={() => {
              closeMenu();
              onToggleFileTree();
            }}
            icon={<FileTreeMenuIcon />}
            label={compactTouchLayout
              ? (isFileTreeOpen ? 'Close review navigation' : 'Open review navigation')
              : (isFileTreeOpen ? 'Hide File Tree' : 'Show File Tree')
            }
            badge={compactTouchLayout ? undefined : <KbdHint keys={[modKey, 'B']} />}
          />
          {!compactTouchLayout && (
            <ActionMenuItem
              onClick={() => {
                closeMenu();
                onToggleSidebar();
              }}
              icon={<SidebarIcon />}
              label={isSidebarOpen ? 'Hide Sidebar' : 'Show Sidebar'}
              badge={<KbdHint keys={[modKey, '.']} />}
            />
          )}

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

const GuideIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M8 6h8M8 10h8M8 14h5M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z" />
  </svg>
);

const AgentDestinationIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M8 9h8m-8 4h5m-7 7 3-3h8a3 3 0 003-3V7a3 3 0 00-3-3H5a3 3 0 00-3 3v7a3 3 0 003 3h1v3z" />
  </svg>
);

const CompactReviewActionIcon: React.FC<{ kind: CompactReviewAction['id'] }> = ({ kind }) => {
  if (kind === 'approve') {
    return (
      <svg className="w-3.5 h-3.5 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    );
  }
  if (kind === 'feedback') {
    return (
      <svg className="w-3.5 h-3.5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-4l-4 4v-4z" />
      </svg>
    );
  }
  if (kind === 'copy') return <ExportIcon />;
  return <CloseIcon />;
};
