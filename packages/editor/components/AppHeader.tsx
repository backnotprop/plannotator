import React from 'react';
import type { Origin } from '@plannotator/shared/agents';
import type { Agent } from '@plannotator/ui/hooks/useAgents';
import { FeedbackButton, ApproveButton, ExitButton } from '@plannotator/ui/components/ToolbarButtons';
import { ApproveDropdown } from '@plannotator/ui/components/ApproveDropdown';
import { Settings } from '@plannotator/ui/components/Settings';
import { PlanHeaderMenu } from '@plannotator/ui/components/PlanHeaderMenu';
import type { CallbackConfig } from '@plannotator/ui/utils/callback';
import type { UIPreferences } from '@plannotator/ui/utils/uiPreferences';

interface AppHeaderProps {
  // Mode flags (stable after mount)
  isApiMode: boolean;
  annotateMode: boolean;
  archiveMode: boolean;
  gate: boolean;
  isSharedSession: boolean;
  origin: Origin | null;

  // Dynamic state
  isSubmitting: boolean;
  isExiting: boolean;
  isPanelOpen: boolean;
  hasAnyAnnotations: boolean;
  linkedDocIsActive: boolean;
  callbackShareUrlReady: boolean;
  canShareCurrentSession: boolean;
  agentName: string;
  availableAgents: Agent[];
  showAnnotationsWarning: boolean;

  // Callback config (null when no bot callback)
  callbackConfig: CallbackConfig | null;

  // Settings props
  taterMode: boolean;
  mobileSettingsOpen: boolean;
  gitUser: string | undefined;

  // Handlers — App owns all decision logic, header just calls these
  onCallbackFeedback: () => void;
  onCallbackApprove: () => void;
  onAnnotateExit: () => void;
  onAnnotateFeedback: () => void;
  onAnnotateApprove: () => void;
  onFeedback: () => void;
  onApprove: () => void;
  onAnnotationPanelToggle: () => void;
  onArchiveCopy: () => void;
  onArchiveDone: () => void;
  onTaterModeChange: (enabled: boolean) => void;
  onIdentityChange: (oldId: string, newId: string) => void;
  onUIPreferencesChange: (prefs: UIPreferences) => void;
  onOpenSettings: () => void;
  onCloseSettings: () => void;
  onOpenExport: () => void;
  onCopyAgentInstructions: () => void;
  onDownloadAnnotations: () => void;
  onPrint: () => void;
  onCopyShareLink: () => void;
  onOpenImport: () => void;
  onSaveToObsidian: () => void;
  onSaveToBear: () => void;
  onSaveToOctarine: () => void;

  // PlanHeaderMenu config
  appVersion: string;
  agentInstructionsEnabled: boolean;
  obsidianConfigured: boolean;
  bearConfigured: boolean;
  octarineConfigured: boolean;
}

export const AppHeader = React.memo<AppHeaderProps>(({
  isApiMode,
  annotateMode,
  archiveMode,
  gate,
  isSharedSession,
  origin,
  isSubmitting,
  isExiting,
  isPanelOpen,
  hasAnyAnnotations,
  linkedDocIsActive,
  callbackShareUrlReady,
  canShareCurrentSession,
  agentName,
  availableAgents,
  showAnnotationsWarning,
  callbackConfig,
  taterMode,
  mobileSettingsOpen,
  gitUser,
  onCallbackFeedback,
  onCallbackApprove,
  onAnnotateExit,
  onAnnotateFeedback,
  onAnnotateApprove,
  onFeedback,
  onApprove,
  onAnnotationPanelToggle,
  onArchiveCopy,
  onArchiveDone,
  onTaterModeChange,
  onIdentityChange,
  onUIPreferencesChange,
  onOpenSettings,
  onCloseSettings,
  onOpenExport,
  onCopyAgentInstructions,
  onDownloadAnnotations,
  onPrint,
  onCopyShareLink,
  onOpenImport,
  onSaveToObsidian,
  onSaveToBear,
  onSaveToOctarine,
  appVersion,
  agentInstructionsEnabled,
  obsidianConfigured,
  bearConfigured,
  octarineConfigured,
}) => {
  return (
    <header data-app-header="true" className="h-12 flex items-center justify-between px-2 md:px-4 border-b border-border/50 bg-card/50 backdrop-blur-xl sticky top-0 z-[50]">
      <AppHeaderLogo />

      <div className="flex items-center gap-1 md:gap-2">
        {/* Bot callback buttons — only shown when ?cb=&ct= params are present */}
        {callbackConfig && !isApiMode && isSharedSession && (
          <>
            <div className="w-px h-5 bg-border/50 mx-1 hidden md:block" />
            <FeedbackButton
              onClick={onCallbackFeedback}
              disabled={isSubmitting || !callbackShareUrlReady}
              isLoading={isSubmitting}
              title="Send feedback to bot"
            />
            <ApproveButton
              onClick={onCallbackApprove}
              disabled={isSubmitting || !callbackShareUrlReady}
              isLoading={isSubmitting}
              title="Approve design and notify bot"
            />
          </>
        )}

        {isApiMode && !linkedDocIsActive && archiveMode && (
          <>
            <button
              onClick={onArchiveCopy}
              className="px-2.5 py-1 rounded-md text-xs font-medium transition-all bg-muted text-foreground hover:bg-muted/80 border border-border"
              title="Copy plan content"
            >
              <span className="hidden md:inline">Copy</span>
              <svg className="w-4 h-4 md:hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
            <button
              onClick={onArchiveDone}
              className="px-2.5 py-1 rounded-md text-xs font-medium transition-all bg-success text-success-foreground hover:opacity-90"
              title="Close archive"
            >
              Done
            </button>
          </>
        )}

        {isApiMode && (!linkedDocIsActive || annotateMode) && !archiveMode && (
          <>
            {annotateMode ? (
              <>
                <ExitButton
                  onClick={onAnnotateExit}
                  disabled={isSubmitting || isExiting}
                  isLoading={isExiting}
                />
                {hasAnyAnnotations && (
                  <FeedbackButton
                    onClick={onAnnotateFeedback}
                    disabled={isSubmitting || isExiting}
                    isLoading={isSubmitting}
                    label="Send Annotations"
                    title="Send Annotations"
                  />
                )}
              </>
            ) : (
              <FeedbackButton
                onClick={onFeedback}
                disabled={isSubmitting}
                isLoading={isSubmitting}
                label="Send Feedback"
                title="Send Feedback"
              />
            )}

            {(!annotateMode || gate) && (
              origin === 'opencode' && !annotateMode && availableAgents.length > 0 ? (
                <ApproveDropdown
                  onApprove={onApprove}
                  agents={availableAgents}
                  disabled={isSubmitting}
                  isLoading={isSubmitting}
                />
              ) : (
                <div className="relative group/approve">
                  <ApproveButton
                    onClick={onApprove}
                    disabled={isSubmitting || (annotateMode && isExiting)}
                    isLoading={isSubmitting}
                    dimmed={!annotateMode && (origin === 'claude-code' || origin === 'gemini-cli') && showAnnotationsWarning}
                    title={annotateMode ? 'Approve — no changes requested' : undefined}
                  />
                  {!annotateMode && (origin === 'claude-code' || origin === 'gemini-cli') && showAnnotationsWarning && (
                    <div className="absolute top-full right-0 mt-2 px-3 py-2 bg-popover border border-border rounded-lg shadow-xl text-xs text-foreground w-56 text-center opacity-0 invisible group-hover/approve:opacity-100 group-hover/approve:visible transition-all pointer-events-none z-50">
                      <div className="absolute bottom-full right-4 border-4 border-transparent border-b-border" />
                      <div className="absolute bottom-full right-4 mt-px border-4 border-transparent border-b-popover" />
                      {agentName} doesn't support feedback on approval. Your annotations won't be seen.
                    </div>
                  )}
                </div>
              )
            )}

            <div className="w-px h-5 bg-border/50 mx-1 hidden md:block" />
          </>
        )}

        {/* Annotations panel toggle */}
        <button
          onClick={onAnnotationPanelToggle}
          className={`p-1.5 rounded-md text-xs font-medium transition-all ${
            isPanelOpen
              ? 'bg-primary/15 text-primary'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted'
          }`}
          title={isPanelOpen ? 'Hide annotations' : 'Show annotations'}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
          </svg>
        </button>

        {/* Settings dialog (controlled, button hidden — opened from PlanHeaderMenu) */}
        <div className="hidden">
          <Settings
            taterMode={taterMode}
            onTaterModeChange={onTaterModeChange}
            onIdentityChange={onIdentityChange}
            origin={origin}
            onUIPreferencesChange={onUIPreferencesChange}
            externalOpen={mobileSettingsOpen}
            onExternalClose={onCloseSettings}
            gitUser={gitUser}
          />
        </div>

        <PlanHeaderMenu
          appVersion={appVersion}
          onOpenSettings={onOpenSettings}
          onOpenExport={onOpenExport}
          onCopyAgentInstructions={onCopyAgentInstructions}
          onDownloadAnnotations={onDownloadAnnotations}
          onPrint={onPrint}
          onCopyShareLink={onCopyShareLink}
          onOpenImport={onOpenImport}
          onSaveToObsidian={onSaveToObsidian}
          onSaveToBear={onSaveToBear}
          onSaveToOctarine={onSaveToOctarine}
          sharingEnabled={canShareCurrentSession}
          isApiMode={isApiMode}
          agentInstructionsEnabled={agentInstructionsEnabled}
          obsidianConfigured={obsidianConfigured}
          bearConfigured={bearConfigured}
          octarineConfigured={octarineConfigured}
        />
      </div>
    </header>
  );
});

const AppHeaderLogo = () => (
  <div className="flex items-center gap-2 md:gap-3">
    <a
      href="https://plannotator.ai"
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-1.5 md:gap-2 hover:opacity-80 transition-opacity"
    >
      <span className="text-sm font-semibold tracking-tight">Plannotator</span>
    </a>
  </div>
);
