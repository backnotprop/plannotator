/**
 * SidebarTabs — Collapsed tab flags
 *
 * When the sidebar is closed, small vertical tabs protrude from the left edge.
 * Clicking a tab opens the sidebar in that mode.
 */

import React from "react";
import type { SidebarTab } from "../../hooks/useSidebar";

interface SidebarTabsProps {
  activeTab: SidebarTab;
  onToggleTab: (tab: SidebarTab) => void;
  hasDiff: boolean;
  showVaultTab?: boolean;
  showHistoryTab?: boolean;
  hasHistory?: boolean;
  className?: string;
}

export const SidebarTabs: React.FC<SidebarTabsProps> = ({
  activeTab,
  onToggleTab,
  hasDiff,
  showVaultTab,
  showHistoryTab,
  hasHistory,
  className,
}) => {
  return (
    <div
      className={`flex flex-col gap-1 pt-3 pl-0.5 flex-shrink-0 ${className ?? ""}`}
    >
      {/* TOC tab */}
      <button
        onClick={() => onToggleTab("toc")}
        className="sidebar-tab-flag group flex items-center justify-center w-7 h-9 rounded-r-md border border-l-0 border-border/50 bg-card/80 backdrop-blur-sm text-muted-foreground hover:text-foreground hover:bg-card transition-colors"
        title="Table of Contents"
      >
        <svg
          className="w-3.5 h-3.5"
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
      </button>

      {/* Versions tab */}
      <button
        onClick={() => onToggleTab("versions")}
        className="sidebar-tab-flag group relative flex items-center justify-center w-7 h-9 rounded-r-md border border-l-0 border-border/50 bg-card/80 backdrop-blur-sm text-muted-foreground hover:text-foreground hover:bg-card transition-colors"
        title="Plan Versions"
      >
        <svg
          className="w-3.5 h-3.5"
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
        {/* Availability indicator dot */}
        {hasDiff && (
          <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-primary" />
        )}
      </button>

      {/* Vault tab */}
      {showVaultTab && (
        <button
          onClick={() => onToggleTab("vault")}
          className="sidebar-tab-flag group flex items-center justify-center w-7 h-9 rounded-r-md border border-l-0 border-border/50 bg-card/80 backdrop-blur-sm text-muted-foreground hover:text-foreground hover:bg-card transition-colors"
          title="Vault Browser"
        >
          <svg
            className="w-3.5 h-3.5"
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
        </button>
      )}

      {/* Review History tab */}
      {showHistoryTab && (
        <button
          onClick={() => onToggleTab("history")}
          className="sidebar-tab-flag group relative flex items-center justify-center w-7 h-9 rounded-r-md border border-l-0 border-border/50 bg-card/80 backdrop-blur-sm text-muted-foreground hover:text-foreground hover:bg-card transition-colors"
          title="Review History"
        >
          <svg
            className="w-3.5 h-3.5"
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
          {/* Availability indicator dot */}
          {hasHistory && (
            <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-accent" />
          )}
        </button>
      )}
    </div>
  );
};
