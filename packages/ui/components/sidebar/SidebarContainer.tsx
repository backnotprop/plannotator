/**
 * SidebarContainer — Shared sidebar shell
 *
 * Houses both the Table of Contents and Version Browser views.
 * Tab bar at top switches between them.
 */

import React from "react";
import type { SidebarTab } from "../../hooks/useSidebar";
import type { Block, Annotation } from "../../types";
import type { VersionInfo, VersionEntry, ProjectPlan } from "../../hooks/usePlanDiff";
import { TableOfContents } from "../TableOfContents";
import { VersionBrowser } from "./VersionBrowser";

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
