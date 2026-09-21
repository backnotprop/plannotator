/**
 * SidebarContainer — Shared sidebar shell
 *
 * Houses the Table of Contents, Version Browser, File Browser, and Archive Browser views.
 * Tab bar at top switches between them.
 */

import React from "react";
import type { SidebarTab } from "../../hooks/useSidebar";
import type { Block, Annotation } from "../../types";
import type { VersionInfo, VersionEntry } from "../../hooks/usePlanDiff";
import type { UseFileBrowserReturn } from "../../hooks/useFileBrowser";
import { TableOfContents } from "../TableOfContents";
import { VersionBrowser } from "./VersionBrowser";
import { FileBrowser, type FileEditStatus } from "./FileBrowser";
import { ArchiveBrowser, type ArchivedPlan } from "./ArchiveBrowser";
import { MessagesBrowser, type PickerMessage } from "./MessagesBrowser";
import { MessagesIcon } from "../icons/MessagesIcon";
import { OverlayScrollArea } from "../OverlayScrollArea";
import { ReviewAgentsIcon } from "../ReviewAgentsIcon";

interface SidebarContainerProps {
  /** Desktop preserves the incumbent sticky rail. Compact Plan uses the same
   * content as a safe, visible-viewport-bounded foreground surface. */
  presentation?: "desktop" | "overlay";
  activeTab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  onClose: () => void;
  width: number | string;
  showAgentTerminalButton?: boolean;
  isAgentTerminalOpen?: boolean;
  isAgentTerminalRunning?: boolean;
  onToggleAgentTerminal?: () => void;
  // TOC props
  showContentsTab?: boolean;
  blocks: Block[];
  annotations: Annotation[];
  activeSection: string | null;
  onTocNavigate: (blockId: string) => void;
  linkedDocFilepath?: string | null;
  onLinkedDocBack?: () => void;
  backLabel?: string;
  // File Browser props
  showFilesTab?: boolean;
  fileAnnotationCounts?: Map<string, number>;
  highlightedFiles?: Set<string>;
  fileEditStatuses?: Map<string, FileEditStatus>;
  fileBrowser?: UseFileBrowserReturn;
  onFilesSelectFile?: (absolutePath: string, dirPath: string) => void;
  onFilesFetchAll?: () => void;
  onFilesRetryVaultDir?: (vaultPath: string) => void;
  /** Compact-only file activation feedback; desktop does not pass this. */
  pendingFileLabel?: string | null;
  // Version Browser props
  showVersionsTab?: boolean;
  versionInfo: VersionInfo | null;
  versions: VersionEntry[];
  selectedBaseVersion: number | null;
  onSelectBaseVersion: (version: number) => void;
  isPlanDiffActive: boolean;
  hasPreviousVersion: boolean;
  onActivatePlanDiff: () => void;
  isLoadingVersions: boolean;
  isSelectingVersion: boolean;
  fetchingVersion: number | null;
  onFetchVersions: () => void;
  // Annotation indicators
  hasFileAnnotations?: boolean;
  // Archive Browser props
  showArchiveTab?: boolean;
  archivePlans: ArchivedPlan[];
  selectedArchiveFile: string | null;
  onArchiveSelect: (filename: string) => void;
  isLoadingArchive: boolean;
  showMessagesTab?: boolean;
  messages?: PickerMessage[];
  selectedMessageId?: string | null;
  onSelectMessage?: (messageId: string) => void;
  messageAnnotationCounts?: Map<string, number>;
}

export const SidebarContainer: React.FC<SidebarContainerProps> = ({
  presentation = "desktop",
  activeTab,
  onTabChange,
  onClose,
  width,
  showAgentTerminalButton,
  isAgentTerminalOpen,
  isAgentTerminalRunning,
  onToggleAgentTerminal,
  showContentsTab = true,
  blocks,
  annotations,
  activeSection,
  onTocNavigate,
  linkedDocFilepath,
  onLinkedDocBack,
  backLabel,
  showFilesTab,
  fileAnnotationCounts,
  highlightedFiles,
  fileEditStatuses,
  fileBrowser,
  onFilesSelectFile,
  onFilesFetchAll,
  onFilesRetryVaultDir,
  pendingFileLabel,
  showVersionsTab,
  versionInfo,
  versions,
  selectedBaseVersion,
  onSelectBaseVersion,
  isPlanDiffActive,
  hasPreviousVersion,
  onActivatePlanDiff,
  isLoadingVersions,
  isSelectingVersion,
  fetchingVersion,
  onFetchVersions,
  hasFileAnnotations,
  showArchiveTab,
  archivePlans,
  selectedArchiveFile,
  onArchiveSelect,
  isLoadingArchive,
  showMessagesTab,
  messages,
  selectedMessageId,
  onSelectMessage,
  messageAnnotationCounts,
}) => {
  const compact = presentation === "overlay";
  const closeButtonRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    if (compact) closeButtonRef.current?.focus({ preventScroll: true });
  }, [compact]);

  const handleCompactKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!compact) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      ),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  return (
    <aside
      id={compact ? "pn-compact-plan-navigator" : undefined}
      data-pn-plan-navigator={compact ? "true" : undefined}
      // The compact navigator (Contents / Versions / Archive) is the same kind
      // of full-viewport transient surface as CompactPlanStage, so it must not
      // print over the document either. Desktop rail printing is unchanged.
      data-print-hide={compact ? true : undefined}
      role={compact ? "dialog" : undefined}
      aria-modal={compact ? true : undefined}
      aria-label={compact ? "Plan navigator" : undefined}
      onKeyDown={compact ? handleCompactKeyDown : undefined}
      className={compact
        ? "pn-visible-viewport-stage z-[90] flex flex-col overflow-hidden bg-card text-foreground"
        : "hidden lg:flex flex-col sticky top-12 h-[calc(100vh-3rem)] flex-shrink-0 bg-card border-r border-border"}
      style={{ width: compact ? undefined : width }}
    >
      {compact && (
        <div className="flex h-[52px] flex-shrink-0 items-center justify-between border-b border-border/50 px-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold tracking-tight">Navigate</p>
            <p className="truncate text-[11px] text-muted-foreground" aria-live="polite">
              {pendingFileLabel ? `Opening ${pendingFileLabel}…` : 'Choose what to review'}
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            data-pn-touch-target="true"
            data-pn-touch-target-icon="true"
            className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
            aria-label="Close navigator"
            title="Close navigator"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Tab bar */}
      <div className={compact
        ? "flex min-h-11 items-center gap-1 overflow-x-auto border-b border-border/50 px-2 py-1"
        : "flex h-10 items-center border-b border-border/50 px-2 gap-0.5 flex-shrink-0 overflow-hidden min-w-0"}
      >
        {!compact && showAgentTerminalButton && onToggleAgentTerminal && (
          <ActionButton
            active={!!isAgentTerminalOpen}
            running={!!isAgentTerminalRunning}
            onClick={onToggleAgentTerminal}
            icon={<ReviewAgentsIcon className="w-3 h-3" />}
            label="Agent"
          />
        )}
        {showContentsTab && (
          <TabButton
            active={activeTab === "toc"}
            onClick={() => onTabChange("toc")}
            icon={
              <svg
                className="w-3 h-3"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 6h16M4 10h16M4 14h10M4 18h10"
                />
              </svg>
            }
            label="Contents"
            touch={compact}
          />
        )}
        {showVersionsTab && (
          <TabButton
            active={activeTab === "versions"}
            onClick={() => onTabChange("versions")}
            icon={
              <svg
                className="w-3 h-3"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            }
            label="Versions"
            touch={compact}
          />
        )}
        {showMessagesTab && (
          <TabButton
            active={activeTab === "messages"}
            onClick={() => onTabChange("messages")}
            icon={<MessagesIcon className="w-3 h-3" />}
            label="Messages"
            badge={messageAnnotationCounts !== undefined && messageAnnotationCounts.size > 0}
            touch={compact}
          />
        )}
        {showFilesTab && (
          <TabButton
            active={activeTab === "files"}
            onClick={() => onTabChange("files")}
            icon={
              <svg
                className="w-3 h-3"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
            }
            label="Files"
            badge={hasFileAnnotations}
            touch={compact}
          />
        )}
        {showArchiveTab && (
          <TabButton
            active={activeTab === "archive"}
            onClick={() => onTabChange("archive")}
            icon={
              <svg
                className="w-3 h-3"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
                />
              </svg>
            }
            label="Archive"
            touch={compact}
          />
        )}
        {/* No header close button — the sidebar collapses via the resize-handle
            hover button (see ResizeHandle onCollapse). */}
      </div>

      {/* Content area */}
      <OverlayScrollArea className={compact
        ? "flex-1 min-h-0 overscroll-contain [-webkit-overflow-scrolling:touch]"
        : "flex-1 min-h-0"}
      >
        {activeTab === "toc" && showContentsTab && (
          <TableOfContents
            blocks={blocks}
            annotations={annotations}
            activeId={activeSection}
            onNavigate={onTocNavigate}
            className=""
            linkedDocFilepath={linkedDocFilepath}
            onLinkedDocBack={onLinkedDocBack}
            backLabel={backLabel}
          />
        )}
        {activeTab === "versions" && (
          <VersionBrowser
            versionInfo={versionInfo}
            versions={versions}
            selectedBaseVersion={selectedBaseVersion}
            onSelectBaseVersion={onSelectBaseVersion}
            isPlanDiffActive={isPlanDiffActive}
            hasPreviousVersion={hasPreviousVersion}
            onActivatePlanDiff={onActivatePlanDiff}
            isLoading={isLoadingVersions}
            isSelectingVersion={isSelectingVersion}
            fetchingVersion={fetchingVersion}
            onFetchVersions={onFetchVersions}
          />
        )}
        {activeTab === "files" && showFilesTab && fileBrowser && (
          <FileBrowser
            dirs={fileBrowser.dirs}
            expandedFolders={fileBrowser.expandedFolders}
            onToggleFolder={fileBrowser.toggleFolder}
            collapsedDirs={fileBrowser.collapsedDirs}
            onToggleCollapse={fileBrowser.toggleCollapse}
            onSelectFile={onFilesSelectFile ?? (() => {})}
            activeFile={fileBrowser.activeFile}
            onFetchAll={onFilesFetchAll ?? (() => {})}
            onRetryVaultDir={onFilesRetryVaultDir}
            annotationCounts={fileAnnotationCounts}
            highlightedFiles={highlightedFiles}
            editStatuses={fileEditStatuses}
            selectionPending={compact && !!pendingFileLabel}
          />
        )}
        {activeTab === "archive" && showArchiveTab && (
          <ArchiveBrowser
            plans={archivePlans}
            selectedFile={selectedArchiveFile}
            onSelect={onArchiveSelect}
            isLoading={isLoadingArchive}
          />
        )}
        {activeTab === "messages" && showMessagesTab && messages && onSelectMessage && (
          <MessagesBrowser
            messages={messages}
            selectedMessageId={selectedMessageId ?? null}
            onSelect={onSelectMessage}
            annotationCounts={messageAnnotationCounts}
          />
        )}
      </OverlayScrollArea>
    </aside>
  );
};

const TabButton: React.FC<{
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge?: boolean;
  touch?: boolean;
}> = ({ active, onClick, icon, label, badge, touch = false }) => (
  <button
    type="button"
    onClick={onClick}
    data-pn-touch-target={touch ? "true" : undefined}
    className={`relative flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors min-w-0 shrink-0${touch ? " h-9" : ""} ${
      active
        ? "bg-primary/10 text-primary"
        : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
    }`}
  >
    {icon}
    {label}
    {badge && (
      <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-primary" />
    )}
</button>
);

const ActionButton: React.FC<{
  active: boolean;
  running?: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}> = ({ active, running, onClick, icon, label }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    title={running ? "Agent running" : label}
    className={`relative flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors min-w-0 shrink-0 ${
      active || running
        ? "bg-primary/10 text-primary"
        : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
    }`}
  >
    {icon}
    {label}
    {running && (
      <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-primary" />
    )}
  </button>
);
