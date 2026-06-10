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
import { FileBrowser } from "./FileBrowser";
import { ArchiveBrowser, type ArchivedPlan } from "./ArchiveBrowser";
import { MessagesBrowser, type PickerMessage } from "./MessagesBrowser";
import { MessagesIcon } from "../icons/MessagesIcon";
import { OverlayScrollArea } from "../OverlayScrollArea";

interface SidebarContainerProps {
  activeTab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  onClose: () => void;
  width: number | string;
  // TOC props
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
  fileBrowser?: UseFileBrowserReturn;
  onFilesSelectFile?: (absolutePath: string, dirPath: string) => void;
  onFilesFetchAll?: () => void;
  onFilesRetryVaultDir?: (vaultPath: string) => void;
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
  activeTab,
  onTabChange,
  onClose,
  width,
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
  fileBrowser,
  onFilesSelectFile,
  onFilesFetchAll,
  onFilesRetryVaultDir,
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
  return (
    <aside
      className="hidden lg:flex flex-col sticky top-12 h-[calc(100vh-3rem)] flex-shrink-0 bg-card border-r border-border"
      style={{ width }}
    >
      {/* Tab bar */}
      <div className="flex h-10 items-center border-b border-border/50 px-2 gap-0.5 flex-shrink-0 overflow-hidden min-w-0">
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
        />
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
          />
        )}
        {showMessagesTab && (
          <TabButton
            active={activeTab === "messages"}
            onClick={() => onTabChange("messages")}
            icon={<MessagesIcon className="w-3 h-3" />}
            label="Messages"
            badge={messageAnnotationCounts !== undefined && messageAnnotationCounts.size > 0}
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
          />
        )}
        {/* No header close button — the sidebar collapses via the resize-handle
            hover button (see ResizeHandle onCollapse). */}
      </div>

      {/* Content area */}
      <OverlayScrollArea className="flex-1 min-h-0">
        {activeTab === "toc" && (
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
}> = ({ active, onClick, icon, label, badge }) => (
  <button
    onClick={onClick}
    className={`relative flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors min-w-0 shrink-0 ${
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
