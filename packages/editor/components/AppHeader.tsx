import type { UpdateCheckSetting } from '@plannotator/ui/hooks/useUpdateCheckSetting';
import type { CookieHostSetting } from '@plannotator/ui/hooks/useCookieHostSetting';
import React from 'react';
import type { Origin } from '@plannotator/shared/agents';
import type { UpdateInfo } from '@plannotator/ui/hooks/useUpdateCheck';
import { FeedbackButton, ApproveButton, ExitButton } from '@plannotator/ui/components/ToolbarButtons';
import { DecisionControl, type DecisionControlProps, type DecisionHandler } from '@plannotator/ui/components/DecisionControl';
import { QuestionProgressChip } from '@plannotator/ui/components/QuestionProgressChip';
import type { DecisionActionId, DecisionSpec } from '@plannotator/ui/utils/decisionSpec';
import { Settings } from '@plannotator/ui/components/Settings';
import { PlanHeaderMenu } from '@plannotator/ui/components/PlanHeaderMenu';
import type { CallbackConfig } from '@plannotator/ui/utils/callback';
import type { UIPreferences } from '@plannotator/ui/utils/uiPreferences';
import type { PermissionMode } from '@plannotator/ui/utils/permissionMode';
import type { AgentToolSetting } from '@plannotator/ui/utils/agentToolSetting';
import { SparklesIcon } from '@plannotator/ui/components/SparklesIcon';
import type { CompactPlanAction } from '@plannotator/ui/components/PlanHeaderMenu';
import { HtmlSurfaceControls } from '@plannotator/ui/components/HtmlSurfaceControls';
import { Tooltip } from '@plannotator/ui/components/Tooltip';
import { StartCutPath } from '@plannotator/ui/components/StartCutPath';
import { BundleSwitcher, type BundleSwitcherProps } from './BundleSwitcher';

export const PLANNOTATOR_HTML_REFRESH_LABELS = {
  refreshTitle: 'Refresh HTML from disk',
  refreshingTitle: 'Refreshing HTML from disk',
} as const;

interface AppHeaderProps {
  sticky?: boolean;
  htmlSurface?: boolean;
  htmlAnnotateArmed?: boolean;
  onToggleHtmlAnnotate?: () => void;
  htmlToolsHidden?: boolean;
  onToggleHtmlTools?: () => void;
  canRefreshHtml?: boolean;
  isRefreshingHtml?: boolean;
  onRefreshHtml?: () => void;
  onHtmlLinkedDocBack?: () => void;
  htmlLinkedDocBackDescription?: string;
  compactTouchLayout?: boolean;
  compactNavigatorAvailable?: boolean;
  compactNavigatorOpen?: boolean;
  onCompactNavigatorToggle?: () => void;
  compactDocumentTitle?: string;
  compactSessionActions?: CompactPlanAction[];
  compactDocumentActions?: CompactPlanAction[];
  bundleSwitcher?: BundleSwitcherProps;
  documentName?: { name: string; title?: string; cutsFromStart?: boolean };
  isApiMode: boolean;
  annotateMode: boolean;
  archiveMode: boolean;
  goalSetupMode: boolean;
  goalSetupCanSubmit: boolean;
  goalSetupIsSubmitting: boolean;
  goalSetupSubmitLabel: string;
  isSharedSession: boolean;
  origin: Origin | null;

  isSubmitting: boolean;
  isExiting: boolean;
  isPanelOpen: boolean;
  aiAvailable: boolean;
  isAIChatOpen: boolean;
  aiHasMessages: boolean;
  annotationCount: number;
  linkedDocIsActive: boolean;
  callbackShareUrlReady: boolean;
  canShareCurrentSession: boolean;
  questionProgress?: { done: number; total: number; hasOpen: boolean; onJump: () => void };
  planDecision?: {
    spec: DecisionSpec;
    handlers: Record<DecisionActionId, DecisionHandler>;
    menuFooter?: DecisionControlProps['menuFooter'];
  };
  annotateDecision?: {
    spec: DecisionSpec;
    handlers: Record<DecisionActionId, DecisionHandler>;
    closeTitle: string;
    dismissOnIframeFocus?: boolean;
  };
  decisionNoteRequest?: number;

  callbackConfig: CallbackConfig | null;

  taterMode: boolean;
  mobileSettingsOpen: boolean;
  gitUser: string | undefined;
  autoUpdateSetting?: { env?: boolean };
  updateCheckSetting?: UpdateCheckSetting;
  cookieHostSetting?: CookieHostSetting;
  agentToolSetting?: AgentToolSetting;
  onAgentToolChange?: (enabled: boolean) => Promise<void>;
  agentTerminalAvailable: boolean;
  webmcpAvailable?: boolean;
  documentTextSizeAvailable?: boolean;
  agentConnected?: boolean;

  onCallbackFeedback: () => void;
  onCallbackApprove: () => void;
  onAnnotateExit: () => void;
  onGoalSetupExit: () => void;
  onGoalSetupSubmit: () => void;
  onAnnotationPanelToggle: () => void;
  onAIChatToggle: () => void;
  onArchiveCopy: () => void;
  onArchiveDone: () => void;
  onTaterModeChange: (enabled: boolean) => void;
  onIdentityChange: (oldId: string, newId: string) => void;
  onUIPreferencesChange: (prefs: UIPreferences) => void;
  onPermissionModeChange?: (mode: PermissionMode) => void;
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
  onSaveToNotion?: () => void;

  appVersion: string;
  updateInfo?: UpdateInfo | null;
  isWSL?: boolean;
  agentInstructionsEnabled: boolean;
  obsidianConfigured: boolean;
  bearConfigured: boolean;
  octarineConfigured: boolean;
  notionConfigured?: boolean;
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
  onHtmlLinkedDocBack,
  htmlLinkedDocBackDescription,
  compactTouchLayout = false,
  compactNavigatorAvailable = false,
  compactNavigatorOpen = false,
  onCompactNavigatorToggle,
  compactDocumentTitle,
  compactSessionActions,
  compactDocumentActions,
  bundleSwitcher,
  documentName,
  isApiMode,
  annotateMode,
  archiveMode,
  goalSetupMode,
  goalSetupCanSubmit,
  goalSetupIsSubmitting,
  goalSetupSubmitLabel,
  isSharedSession,
  origin,
  isSubmitting,
  isExiting,
  isPanelOpen,
  aiAvailable,
  isAIChatOpen,
  aiHasMessages,
  annotationCount,
  linkedDocIsActive,
  callbackShareUrlReady,
  canShareCurrentSession,
  questionProgress,
  annotateDecision,
  planDecision,
  decisionNoteRequest,
  callbackConfig,
  taterMode,
  mobileSettingsOpen,
  gitUser,
  autoUpdateSetting,
  updateCheckSetting,
  cookieHostSetting,
  agentToolSetting,
  onAgentToolChange,
  agentTerminalAvailable,
  webmcpAvailable = false,
  documentTextSizeAvailable = false,
  agentConnected = false,
  onCallbackFeedback,
  onCallbackApprove,
  onAnnotateExit,
  onGoalSetupExit,
  onGoalSetupSubmit,
  onAnnotationPanelToggle,
  onAIChatToggle,
  onArchiveCopy,
  onArchiveDone,
  onTaterModeChange,
  onIdentityChange,
  onUIPreferencesChange,
  onPermissionModeChange,
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
  onSaveToNotion,
  appVersion,
  updateInfo,
  isWSL,
  agentInstructionsEnabled,
  obsidianConfigured,
  bearConfigured,
  octarineConfigured,
  notionConfigured = false,
}) => {
  return (
    <header
      data-app-header="true"
      className={`${compactTouchLayout ? 'h-[52px] grid grid-cols-[44px_minmax(0,1fr)_44px] items-center px-1' : 'h-12 flex items-center justify-between px-2 md:px-4'} border-b border-border/50 bg-card/50 backdrop-blur-xl z-[50] ${sticky ? 'sticky top-0' : 'relative'}`}
    >
      <div className={compactTouchLayout ? 'flex items-center justify-start' : 'flex min-w-0 items-center gap-2'}>
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
          <>
            <AppHeaderLogo />
            {bundleSwitcher ? (
              <BundleSwitcher {...bundleSwitcher} />
            ) : documentName ? (
              <HeaderDocumentName {...documentName} />
            ) : null}
          </>
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

      <div className={`flex items-center gap-1 md:gap-2 ${compactTouchLayout ? 'justify-end' : 'shrink-0'}`}>
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
            {questionProgress && questionProgress.total > 0 && (
              <QuestionProgressChip
                done={questionProgress.done}
                total={questionProgress.total}
                hasOpen={questionProgress.hasOpen}
                onJump={questionProgress.onJump}
              />
            )}
            {annotateMode ? (
              <>
                <ExitButton
                  appearance="ghost"
                  onClick={onAnnotateExit}
                  disabled={isSubmitting || isExiting}
                  isLoading={isExiting}
                  title={annotateDecision?.closeTitle}
                />
                {annotateDecision && (
                  <DecisionControl
                    spec={annotateDecision.spec}
                    handlers={annotateDecision.handlers}
                    busy={isSubmitting || isExiting}
                    isLoading={isSubmitting}
                    dismissOnIframeFocus={annotateDecision.dismissOnIframeFocus}
                    openNoteRequest={decisionNoteRequest}
                  />
                )}
              </>
            ) : planDecision ? (
              <DecisionControl
                spec={planDecision.spec}
                handlers={planDecision.handlers}
                busy={isSubmitting}
                isLoading={isSubmitting}
                menuFooter={planDecision.menuFooter}
                openNoteRequest={decisionNoteRequest}
              />
            ) : null}

            <div className="w-px h-5 bg-border/50 mx-1 hidden md:block" />
          </>
        )}

        {htmlSurface && (onToggleHtmlTools || onToggleHtmlAnnotate || onHtmlLinkedDocBack) && (
          <HtmlSurfaceControls
            compact={compactTouchLayout}
            armed={!!htmlAnnotateArmed}
            onToggleArmed={onToggleHtmlAnnotate}
            toolsHidden={!!htmlToolsHidden}
            onToggleTools={onToggleHtmlTools}
            canRefresh={!!canRefreshHtml && !!onRefreshHtml}
            onRefresh={() => onRefreshHtml?.()}
            isRefreshing={!!isRefreshingHtml}
            onBack={onHtmlLinkedDocBack}
            backDescription={htmlLinkedDocBackDescription}
            labels={PLANNOTATOR_HTML_REFRESH_LABELS}
          />
        )}

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

        <div className="hidden">
          <Settings
            taterMode={taterMode}
            onTaterModeChange={onTaterModeChange}
            onIdentityChange={onIdentityChange}
            origin={origin}
            mode={annotateMode ? 'annotate' : 'plan'}
            annotateParity
            onUIPreferencesChange={onUIPreferencesChange}
            onPermissionModeChange={onPermissionModeChange}
            externalOpen={mobileSettingsOpen}
            onExternalClose={onCloseSettings}
            gitUser={gitUser}
            autoUpdateSetting={autoUpdateSetting}
            updateCheckSetting={updateCheckSetting}
            cookieHostSetting={cookieHostSetting}
            agentToolSetting={agentToolSetting}
            onAgentToolChange={onAgentToolChange}
            agentTerminalAvailable={agentTerminalAvailable}
            webmcpAvailable={webmcpAvailable}
            showDocumentTextSize={documentTextSizeAvailable}
            showDocumentFont={documentTextSizeAvailable}
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
          onSaveToNotion={onSaveToNotion}
          sharingEnabled={canShareCurrentSession}
          isApiMode={isApiMode}
          agentInstructionsEnabled={agentInstructionsEnabled}
          obsidianConfigured={!archiveMode && !goalSetupMode && obsidianConfigured}
          bearConfigured={!archiveMode && !goalSetupMode && bearConfigured}
          octarineConfigured={!archiveMode && !goalSetupMode && octarineConfigured}
          notionConfigured={!archiveMode && !goalSetupMode && notionConfigured}
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

const HeaderDocumentName: React.FC<{ name: string; title?: string; cutsFromStart?: boolean }> = ({ name, title, cutsFromStart }) => {
  const descriptionId = React.useId();
  const label = (
    <span
      data-header-document-name="true"
      className={`min-w-0 ${cutsFromStart ? 'flex' : 'truncate'} text-sm text-foreground/90 rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring`}
      tabIndex={title ? 0 : undefined}
      aria-describedby={title ? descriptionId : undefined}
    >
      {cutsFromStart ? <StartCutPath path={name} /> : name}
    </span>
  );
  return (
    <div className="flex min-w-0 items-center gap-2 md:gap-2.5 pl-0.5">
      <span className="shrink-0 text-sm text-muted-foreground/60" aria-hidden="true">/</span>
      {title ? (
        <>
          <Tooltip
            content={<span className="block max-w-[min(560px,calc(100vw-2rem))] whitespace-normal font-mono [overflow-wrap:anywhere]">{title}</span>}
            side="bottom"
            align="start"
            delayDuration={400}
          >
            {label}
          </Tooltip>
          <span id={descriptionId} className="sr-only">{title}</span>
        </>
      ) : label}
    </div>
  );
};

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
