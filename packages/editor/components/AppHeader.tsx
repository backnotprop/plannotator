import React from 'react';
import type { Origin } from '@plannotator/shared/agents';
import type { Agent } from '@plannotator/ui/hooks/useAgents';
import type { UpdateInfo } from '@plannotator/ui/hooks/useUpdateCheck';
import { FeedbackButton, ApproveButton, ExitButton } from '@plannotator/ui/components/ToolbarButtons';
import { ApproveDropdown } from '@plannotator/ui/components/ApproveDropdown';
import { Settings } from '@plannotator/ui/components/Settings';
import { PlanHeaderMenu } from '@plannotator/ui/components/PlanHeaderMenu';
import type { CallbackConfig } from '@plannotator/ui/utils/callback';
import type { UIPreferences } from '@plannotator/ui/utils/uiPreferences';
import { SparklesIcon } from '@plannotator/ui/components/SparklesIcon';
import type { CompactPlanAction } from '@plannotator/ui/components/PlanHeaderMenu';
import { HtmlSurfaceActions } from './HtmlSurfaceActions';

interface AppHeaderProps {
  /** Mobile document-scroll surfaces let Safari own the top edge and scroll
   * this header with the page. Desktop keeps the incumbent sticky header. */
  sticky?: boolean;
  /** HTML annotate surface (raw HTML or live app): shows the pen toggle. */
  htmlSurface?: boolean;
  /** Interact/Annotate toggle for HTML and live-app surfaces: armed means
   *  clicks annotate; unarmed hands the page back its native interaction
   *  (text drag-selection commenting stays live either way). */
  htmlAnnotateArmed?: boolean;
  onToggleHtmlAnnotate?: () => void;
  /** Floating tools (sidebar tongue tabs + comment/attachments cluster) are
   *  fully removed from the DOM while hidden; this button is the way back. */
  htmlToolsHidden?: boolean;
  onToggleHtmlTools?: () => void;
  canRefreshHtml?: boolean;
  isRefreshingHtml?: boolean;
  onRefreshHtml?: () => void;
  /** Compact touch layouts replace the brand mark with a task-focused entry
   * into the full-stage document navigator. Desktop never receives it. */
  compactTouchLayout?: boolean;
  compactNavigatorAvailable?: boolean;
  compactNavigatorOpen?: boolean;
  onCompactNavigatorToggle?: () => void;
  compactDocumentTitle?: string;
  compactSessionActions?: CompactPlanAction[];
  compactDocumentActions?: CompactPlanAction[];
  // Mode flags (stable after mount)
  isApiMode: boolean;
  annotateMode: boolean;
  archiveMode: boolean;
  goalSetupMode: boolean;
  goalSetupCanSubmit: boolean;
  goalSetupIsSubmitting: boolean;
  goalSetupSubmitLabel: string;
  gate: boolean;
  isSharedSession: boolean;
  origin: Origin | null;

  // Dynamic state
  isSubmitting: boolean;
  isExiting: boolean;
  isPanelOpen: boolean;
  aiAvailable: boolean;
  isAIChatOpen: boolean;
  aiHasMessages: boolean;
  hasAnyAnnotations: boolean;
  annotationCount: number;
  linkedDocIsActive: boolean;
  callbackShareUrlReady: boolean;
  canShareCurrentSession: boolean;
  agentName: string;
  availableAgents: Agent[];
  showAnnotationsWarning: boolean;
  annotateApproveLabel: string;
  annotateApproveTitle: string;

  // Callback config (null when no bot callback)
  callbackConfig: CallbackConfig | null;

  // Settings props
  taterMode: boolean;
  mobileSettingsOpen: boolean;
  gitUser: string | undefined;
  /** This session offers the Agent TUI, so Settings shows its Position row. */
  agentTerminalAvailable: boolean;
  /** The browser exposes WebMCP, so Settings shows the "Agent tools" opt-out.
   *  Nothing in the header renders for this alone. */
  webmcpAvailable?: boolean;
  /** A browser agent has completed at least one tool call in this session.
   *  Only then does the unobtrusive "Agent" indicator appear. */
  agentConnected?: boolean;

  // Handlers — App owns all decision logic, header just calls these
  onCallbackFeedback: () => void;
  onCallbackApprove: () => void;
  onAnnotateExit: () => void;
  onGoalSetupExit: () => void;
  onGoalSetupSubmit: () => void;
  onAnnotateFeedback: () => void;
  onAnnotateApprove: () => void;
  onFeedback: () => void;
  onApprove: () => void;
  onAnnotationPanelToggle: () => void;
  onAIChatToggle: () => void;
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
  updateInfo?: UpdateInfo | null;
  isWSL?: boolean;
  agentInstructionsEnabled: boolean;
  obsidianConfigured: boolean;
  bearConfigured: boolean;
  octarineConfigured: boolean;
}

export const AppHeader = React.memo<AppHeaderProps>(({
  sticky = true,
  htmlSurface,
  htmlAnnotateArmed,
  onToggleHtmlAnnotate,
  htmlToolsHidden,
  onToggleHtmlTools,
  canRefreshHtml,
  isRefreshingHtml,
  onRefreshHtml,
  compactTouchLayout = false,
  compactNavigatorAvailable = false,
  compactNavigatorOpen = false,
  onCompactNavigatorToggle,
  compactDocumentTitle,
  compactSessionActions,
  compactDocumentActions,
  isApiMode,
  annotateMode,
  archiveMode,
  goalSetupMode,
  goalSetupCanSubmit,
  goalSetupIsSubmitting,
  goalSetupSubmitLabel,
  gate,
  isSharedSession,
  origin,
  isSubmitting,
  isExiting,
  isPanelOpen,
  aiAvailable,
  isAIChatOpen,
  aiHasMessages,
  hasAnyAnnotations,
  annotationCount,
  linkedDocIsActive,
  callbackShareUrlReady,
  canShareCurrentSession,
  agentName,
  availableAgents,
  showAnnotationsWarning,
  annotateApproveLabel,
  annotateApproveTitle,
  callbackConfig,
  taterMode,
  mobileSettingsOpen,
  gitUser,
  agentTerminalAvailable,
  webmcpAvailable = false,
  agentConnected = false,
  onCallbackFeedback,
  onCallbackApprove,
  onAnnotateExit,
  onGoalSetupExit,
  onGoalSetupSubmit,
  onAnnotateFeedback,
  onAnnotateApprove,
  onFeedback,
  onApprove,
  onAnnotationPanelToggle,
  onAIChatToggle,
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
  updateInfo,
  isWSL,
  agentInstructionsEnabled,
  obsidianConfigured,
  bearConfigured,
  octarineConfigured,
}) => {
  return (
    <header
      data-app-header="true"
      className={`${compactTouchLayout ? 'h-[52px] grid grid-cols-[44px_minmax(0,1fr)_44px] items-center px-1' : 'h-12 flex items-center justify-between px-2 md:px-4'} border-b border-border/50 bg-card/50 backdrop-blur-xl z-[50] ${sticky ? 'sticky top-0' : 'relative'}`}
    >
      <div className={compactTouchLayout ? 'flex items-center justify-start' : 'flex items-center gap-2'}>
        {compactTouchLayout ? (
          compactNavigatorAvailable && onCompactNavigatorToggle ? (
            <CompactPlanNavigatorTrigger
              open={compactNavigatorOpen}
              onToggle={onCompactNavigatorToggle}
            />
          ) : (
            <span className="block h-11 w-11" aria-hidden="true" />
          )
        ) : (
          <AppHeaderLogo />
        )}
      </div>

      {compactTouchLayout && (
        <div
          data-pn-compact-document-title="true"
          className="min-w-0 px-2 text-center text-sm font-medium tracking-tight text-foreground"
          title={compactDocumentTitle}
        >
          <span className="block truncate">{compactDocumentTitle || 'Plan'}</span>
        </div>
      )}

      <div className={`flex items-center gap-1 md:gap-2 ${compactTouchLayout ? 'justify-end' : ''}`}>
        {/* Bot callback buttons — only shown when ?cb=&ct= params are present */}
        {!compactTouchLayout && callbackConfig && !isApiMode && isSharedSession && (
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

        {!compactTouchLayout && isApiMode && !linkedDocIsActive && archiveMode && (
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

        {!compactTouchLayout && isApiMode && !linkedDocIsActive && goalSetupMode && (
          <>
            <ExitButton
              onClick={onGoalSetupExit}
              disabled={isExiting || goalSetupIsSubmitting}
              isLoading={isExiting}
              title="Close goal setup without submitting"
            />
            <ApproveButton
              onClick={onGoalSetupSubmit}
              disabled={!goalSetupCanSubmit || goalSetupIsSubmitting || isExiting}
              isLoading={goalSetupIsSubmitting}
              label={goalSetupSubmitLabel}
              loadingLabel="Submitting..."
              mobileLabel="Submit"
              title={goalSetupSubmitLabel}
            />
            <div className="w-px h-5 bg-border/50 mx-1 hidden md:block" />
          </>
        )}

        {!compactTouchLayout && isApiMode && (!linkedDocIsActive || annotateMode) && !archiveMode && !goalSetupMode && (
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
                    label="Send Feedback"
                    title="Send Feedback"
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
                    label={annotateMode ? annotateApproveLabel : undefined}
                    mobileLabel={annotateMode ? annotateApproveLabel : undefined}
                    title={annotateMode ? annotateApproveTitle : undefined}
                  />
                  {!annotateMode && (origin === 'claude-code' || origin === 'gemini-cli') && showAnnotationsWarning && (
                    <div className="absolute top-full right-0 mt-2 px-3 py-2 bg-popover border border-border rounded-lg shadow-xl text-xs text-foreground w-56 text-center opacity-0 invisible group-hover/approve:opacity-100 group-hover/approve:visible transition-all pointer-events-none z-50">
                      <div className="absolute bottom-full right-4 border-4 border-transparent border-b-border" />
                      <div className="absolute bottom-full right-4 mt-px border-4 border-transparent border-b-popover" />
                      {agentName} doesn't support feedback on approval. Your feedback won't be seen.
                    </div>
                  )}
                </div>
              )
            )}

            <div className="w-px h-5 bg-border/50 mx-1 hidden md:block" />
          </>
        )}

        {/* Interact/Annotate toggle — HTML and live-app surfaces only. A PEN
            icon (deliberately not a speech bubble: the annotations-panel
            button beside it is already a bubble, and the two must be
            distinguishable at a glance — also distinct from the AI sparkles).
            Always the same icon: armed shows the accent color plus a visible
            border; unarmed is muted with a TRANSPARENT border of the same
            width, so the button's box is pixel-identical in both states. */}
        {/* Show/hide tools — removes ALL floating chrome (sidebar tongue tabs +
            the comment/attachments cluster) from the DOM, leaving nothing over
            the page. Sits left of the pen; this button is the only way back,
            so it never hides itself. Eye = tools visible, eye-off = hidden. */}
        {!compactTouchLayout && htmlSurface && onToggleHtmlTools && (
          <HtmlSurfaceActions
            canRefresh={!!canRefreshHtml && !!onRefreshHtml}
            isRefreshing={!!isRefreshingHtml}
            toolsHidden={!!htmlToolsHidden}
            onRefresh={() => onRefreshHtml?.()}
            onToggleTools={onToggleHtmlTools}
          />
        )}

        {!compactTouchLayout && htmlSurface && onToggleHtmlAnnotate && (
          <button
            type="button"
            data-html-annotate-toggle
            onClick={onToggleHtmlAnnotate}
            aria-pressed={!!htmlAnnotateArmed}
            className={`p-1.5 rounded-md border text-xs font-medium transition-all cursor-pointer ${
              htmlAnnotateArmed
                ? 'border-primary/60 bg-primary/15 text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
            title={htmlAnnotateArmed
              ? 'Annotate mode: click an element or select text to comment. Esc to interact'
              : 'Interact mode: clicks reach the page (text selection still comments). Click to annotate'}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.862 4.487zm0 0L19.5 7.125" />
            </svg>
          </button>
        )}

        {/* WebMCP activity indicator. Deliberately absent until a browser
            agent has completed a tool call: the API merely existing must not
            change the page (maintainer ruling). Non-interactive; the opt-out
            lives in Settings. */}
        {!compactTouchLayout && agentConnected && (
          <span
            data-webmcp-indicator="true"
            className="hidden md:inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
            title="A browser agent has used Plannotator's tools in this session. Its comments are marked browser-agent. Turn the tools off in Settings."
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
            Agent
          </span>
        )}

        {/* Annotations panel toggle */}
        {!compactTouchLayout && !goalSetupMode && (
          <button
            onClick={onAnnotationPanelToggle}
            className={`relative p-1.5 rounded-md text-xs font-medium transition-all ${
              isPanelOpen
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
            title={isPanelOpen ? 'Hide annotations' : 'Show annotations'}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
            </svg>
            {annotationCount > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] flex items-center justify-center rounded-full bg-primary text-[8px] font-bold text-primary-foreground px-0.5">
                {annotationCount > 99 ? '99+' : annotationCount}
              </span>
            )}
          </button>
        )}
        {!compactTouchLayout && !goalSetupMode && aiAvailable && (
          <button
            onClick={onAIChatToggle}
            className={`relative p-1.5 rounded-md text-xs font-medium transition-all ${
              isAIChatOpen
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
            title={isAIChatOpen ? 'Hide AI chat' : 'Show AI chat'}
            aria-label={isAIChatOpen ? 'Hide AI chat' : 'Show AI chat'}
          >
            <SparklesIcon className="w-4 h-4" />
            {aiHasMessages && !isAIChatOpen && (
              <span className="absolute top-0 right-0 w-1.5 h-1.5 rounded-full bg-primary" />
            )}
          </button>
        )}

        {/* Settings dialog (controlled, button hidden — opened from PlanHeaderMenu) */}
        <div className="hidden">
          <Settings
            taterMode={taterMode}
            onTaterModeChange={onTaterModeChange}
            onIdentityChange={onIdentityChange}
            origin={origin}
            mode={annotateMode ? 'annotate' : 'plan'}
            onUIPreferencesChange={onUIPreferencesChange}
            externalOpen={mobileSettingsOpen}
            onExternalClose={onCloseSettings}
            gitUser={gitUser}
            agentTerminalAvailable={agentTerminalAvailable}
            webmcpAvailable={webmcpAvailable}
          />
        </div>

        <PlanHeaderMenu
          appVersion={appVersion}
          updateInfo={updateInfo}
          origin={origin}
          isWSL={isWSL}
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
          obsidianConfigured={!archiveMode && !goalSetupMode && obsidianConfigured}
          bearConfigured={!archiveMode && !goalSetupMode && bearConfigured}
          octarineConfigured={!archiveMode && !goalSetupMode && octarineConfigured}
          compactTouchLayout={compactTouchLayout}
          compactSessionActions={compactSessionActions}
          compactDocumentActions={compactDocumentActions}
        />
      </div>
    </header>
  );
});

export const CompactPlanNavigatorTrigger = ({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) => (
  <button
    id="pn-compact-plan-navigator-trigger"
    type="button"
    onClick={onToggle}
    data-pn-touch-target="true"
    data-pn-touch-target-icon="true"
    data-pn-compact-navigator-trigger="true"
    className={`flex h-11 w-11 items-center justify-center rounded-lg text-sm font-semibold tracking-tight outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 ${
      open
        ? 'bg-primary/15 text-primary'
        : 'text-foreground hover:bg-muted'
    }`}
    aria-label={open ? 'Close plan navigator' : 'Open plan navigator'}
    aria-expanded={open}
    aria-controls="pn-compact-plan-navigator"
    title={open ? 'Close navigator' : 'Navigate plan'}
  >
    <svg className="h-[18px] w-[18px] flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 6h14M5 12h14M5 18h9" />
    </svg>
    <span className="sr-only">Plan navigation</span>
  </button>
);

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
