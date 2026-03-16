/**
 * SidebarContainer — Shared sidebar shell
 *
 * Houses the Table of Contents, Version Browser, and Vault Browser views.
 * Tab bar at top switches between them.
 */

import React from "react";
import type { SidebarTab } from "../../hooks/useSidebar";
import type { Block, Annotation } from "../../types";
import type { VersionInfo, VersionEntry, ProjectPlan } from "../../hooks/usePlanDiff";
import type { UseVaultBrowserReturn } from "../../hooks/useVaultBrowser";
import { TableOfContents } from "../TableOfContents";
import { VersionBrowser } from "./VersionBrowser";
import { VaultBrowser } from "./VaultBrowser";
import { ReviewHistory, type ReviewIterationDisplay } from "./ReviewHistory";

interface SidebarContainerProps {
  activeTab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  onClose: () => void;
  width: number;
  // TOC props
  blocks: Block[];
  annotations: Annotation[];
  activeSection: string | null;
  onTocNavigate: (blockId: string) => void;
  linkedDocFilepath?: string | null;
  onLinkedDocBack?: () => void;
  // Vault Browser props
  showVaultTab?: boolean;
  vaultPath?: string;
  vaultBrowser?: UseVaultBrowserReturn;
  onVaultSelectFile?: (relativePath: string) => void;
  onVaultFetchTree?: () => void;
  // Review History props
  showHistoryTab?: boolean;
  hasHistory?: boolean;
  reviewSessionId?: string | null;
  reviewIterations?: ReviewIterationDisplay[];
  currentIteration?: number;
  // Version Browser props
  versionInfo: VersionInfo | null;
  versions: VersionEntry[];
  projectPlans: ProjectPlan[];
  selectedBaseVersion: number | null;
  onSelectBaseVersion: (version: number) => void;
  isPlanDiffActive: boolean;
  hasPreviousVersion: boolean;
  onActivatePlanDiff: () => void;
  isLoadingVersions: boolean;
  isSelectingVersion: boolean;
  fetchingVersion: number | null;
  onFetchVersions: () => void;
  onFetchProjectPlans: () => void;
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
  showVaultTab,
  vaultPath,
  vaultBrowser,
  onVaultSelectFile,
  onVaultFetchTree,
  showHistoryTab,
  hasHistory,
  reviewSessionId,
  reviewIterations,
  currentIteration,
  versionInfo,
  versions,
  projectPlans,
  selectedBaseVersion,
  onSelectBaseVersion,
  isPlanDiffActive,
  hasPreviousVersion,
  onActivatePlanDiff,
  isLoadingVersions,
  isSelectingVersion,
  fetchingVersion,
  onFetchVersions,
  onFetchProjectPlans,
}) => {
  return (
    <aside
      className="hidden lg:flex flex-col sticky top-12 h-[calc(100vh-3rem)] flex-shrink-0 bg-card/50 backdrop-blur-sm border-r border-border"
      style={{ width }}
    >
      {/* Tab bar */}
      <div className="flex items-center border-b border-border/50 px-1 py-1 gap-0.5 flex-shrink-0">
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
        {showVaultTab && (
          <TabButton
            active={activeTab === "vault"}
            onClick={() => onTabChange("vault")}
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
                  d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                />
              </svg>
            }
            label="Vault"
          />
        )}
        {showHistoryTab && (
          <TabButton
            active={activeTab === "history"}
            onClick={() => onTabChange("history")}
            icon={
              <svg
                className="w-3 h-3"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 00-3.7-3.7 48.678 48.678 0 00-7.324 0 4.006 4.006 0 00-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3l-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 003.7 3.7 48.656 48.656 0 007.324 0 4.006 4.006 0 003.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3l-3 3"
                />
              </svg>
            }
            label={`History${hasHistory ? '' : ''}`}
          />
        )}
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title="Close sidebar"
        >
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
              d="M15 19l-7-7 7-7"
            />
          </svg>
        </button>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === "toc" && (
          <TableOfContents
            blocks={blocks}
            annotations={annotations}
            activeId={activeSection}
            onNavigate={onTocNavigate}
            className="overflow-y-auto"
            linkedDocFilepath={linkedDocFilepath}
            onLinkedDocBack={onLinkedDocBack}
          />
        )}
        {activeTab === "versions" && (
          <VersionBrowser
            versionInfo={versionInfo}
            versions={versions}
            projectPlans={projectPlans}
            selectedBaseVersion={selectedBaseVersion}
            onSelectBaseVersion={onSelectBaseVersion}
            isPlanDiffActive={isPlanDiffActive}
            hasPreviousVersion={hasPreviousVersion}
            onActivatePlanDiff={onActivatePlanDiff}
            isLoading={isLoadingVersions}
            isSelectingVersion={isSelectingVersion}
            fetchingVersion={fetchingVersion}
            onFetchVersions={onFetchVersions}
            onFetchProjectPlans={onFetchProjectPlans}
          />
        )}
        {activeTab === "vault" && showVaultTab && vaultPath && vaultBrowser && (
          <VaultBrowser
            vaultPath={vaultPath}
            tree={vaultBrowser.tree}
            isLoading={vaultBrowser.isLoading}
            error={vaultBrowser.error}
            expandedFolders={vaultBrowser.expandedFolders}
            onToggleFolder={vaultBrowser.toggleFolder}
            onSelectFile={onVaultSelectFile ?? (() => {})}
            activeFile={vaultBrowser.activeFile}
            onFetchTree={onVaultFetchTree ?? (() => {})}
          />
        )}
        {activeTab === "history" && showHistoryTab && (
          <ReviewHistory
            sessionId={reviewSessionId ?? null}
            iterations={reviewIterations ?? []}
            currentIteration={currentIteration ?? 1}
          />
        )}
      </div>
    </aside>
  );
};

const TabButton: React.FC<{
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}> = ({ active, onClick, icon, label }) => (
  <button
    onClick={onClick}
    className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors ${
      active
        ? "bg-primary/10 text-primary"
        : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
    }`}
  >
    {icon}
    {label}
  </button>
);
