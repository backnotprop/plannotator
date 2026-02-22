/**
 * SidebarTabs — Collapsed tab flags
 *
 * When the sidebar is closed, two small vertical tabs protrude from the left edge.
 * Clicking a tab opens the sidebar in that mode.
 */

import React from "react";
import type { SidebarTab } from "../../hooks/useSidebar";

interface SidebarTabsProps {
  activeTab: SidebarTab;
  onToggleTab: (tab: SidebarTab) => void;
  hasDiff: boolean;
  className?: string;
}

export const SidebarTabs: React.FC<SidebarTabsProps> = ({
  activeTab,
  onToggleTab,
  hasDiff,
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
    </div>
  );
};
