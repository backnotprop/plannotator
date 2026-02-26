/**
 * PlanDiffViewer — Orchestrator for plan diff views
 *
 * Replaces the Viewer component when plan diff mode is active.
 * Renders the document card with the same styling, but shows
 * diff content instead of the annotatable plan.
 */

import React, { useState } from "react";
import type { PlanDiffBlock, PlanDiffStats } from "../../utils/planDiffEngine";
import {
  PlanDiffModeSwitcher,
  type PlanDiffMode,
} from "./PlanDiffModeSwitcher";
import { PlanCleanDiffView } from "./PlanCleanDiffView";
import { PlanRawDiffView } from "./PlanRawDiffView";
import { PlanDiffBadge } from "./PlanDiffBadge";
import { VSCodeIcon } from "./VSCodeIcon";

interface PlanDiffViewerProps {
  diffBlocks: PlanDiffBlock[];
  diffStats: PlanDiffStats;
  diffMode: PlanDiffMode;
  onDiffModeChange: (mode: PlanDiffMode) => void;
  onPlanDiffToggle: () => void;
  repoInfo?: { display: string; branch?: string } | null;
  baseVersionLabel?: string;
  baseVersion?: number;
}

export const PlanDiffViewer: React.FC<PlanDiffViewerProps> = ({
  diffBlocks,
  diffStats,
  diffMode,
  onDiffModeChange,
  onPlanDiffToggle,
  repoInfo,
  baseVersionLabel,
  baseVersion,
}) => {
  const [vscodeDiffLoading, setVscodeDiffLoading] = useState(false);
  const [vscodeDiffError, setVscodeDiffError] = useState<string | null>(null);

  const canOpenVscodeDiff = baseVersion != null;

  const handleOpenVscodeDiff = async () => {
    if (!canOpenVscodeDiff) return;
    setVscodeDiffLoading(true);
    setVscodeDiffError(null);
    try {
      const res = await fetch("/api/plan/vscode-diff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseVersion }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || data.error) {
        setVscodeDiffError(data.error || "Failed to open VS Code diff");
      }
    } catch {
      setVscodeDiffError("Failed to connect to server");
    } finally {
      setVscodeDiffLoading(false);
    }
  };

  return (
    <div className="relative z-50 w-full max-w-[832px] 2xl:max-w-5xl">
      <article className="w-full max-w-[832px] 2xl:max-w-5xl bg-card border border-border/50 rounded-xl shadow-xl p-5 md:p-8 lg:p-10 xl:p-12 relative">
        {/* Top-left: repo info + diff badge — matches Viewer layout (flex-col) so badge doesn't jump position */}
        <div className="absolute top-3 left-3 md:top-4 md:left-5 flex flex-col items-start gap-1 text-[9px] text-muted-foreground/50 font-mono">
          {repoInfo && (
            <div className="flex items-center gap-1.5">
              <span
                className="px-1.5 py-0.5 bg-muted/50 rounded truncate max-w-[140px]"
                title={repoInfo.display}
              >
                {repoInfo.display}
              </span>
              {repoInfo.branch && (
                <span
                  className="px-1.5 py-0.5 bg-muted/30 rounded max-w-[120px] flex items-center gap-1 overflow-hidden"
                  title={repoInfo.branch}
                >
                  <svg
                    className="w-2.5 h-2.5 flex-shrink-0"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                  >
                    <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
                  </svg>
                  <span className="truncate">{repoInfo.branch}</span>
                </span>
              )}
            </div>
          )}
          <PlanDiffBadge
            stats={diffStats}
            isActive={true}
            onToggle={onPlanDiffToggle}
            hasPreviousVersion={true}
          />
        </div>

        {/* Top-right: back to plan view button */}
        <div className="float-right -mr-4 -mt-4 md:-mr-5 md:-mt-5 lg:-mr-7 lg:-mt-7 xl:-mr-9 xl:-mt-9 p-2">
          <button
            onClick={onPlanDiffToggle}
            className="flex items-center gap-1 px-2 py-1.5 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Back to plan view"
          >
            <span className="hidden md:inline text-[10px] font-medium">Exit Diff</span>
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
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Diff mode switcher + version label + VS Code button */}
        <div className="mt-6 mb-6 flex items-center gap-3">
          <PlanDiffModeSwitcher mode={diffMode} onChange={onDiffModeChange} />
          {baseVersionLabel && (
            <span className="text-[10px] text-muted-foreground">
              vs {baseVersionLabel}
            </span>
          )}
          {canOpenVscodeDiff && (
            <button
              onClick={handleOpenVscodeDiff}
              disabled={vscodeDiffLoading}
              className="ml-auto flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 border border-border/30 transition-colors disabled:opacity-50"
              title="Open diff in VS Code"
            >
              <VSCodeIcon className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="hidden md:inline">
                {vscodeDiffLoading ? "Opening..." : "VS Code"}
              </span>
            </button>
          )}
        </div>

        {/* VS Code diff error message */}
        {vscodeDiffError && (
          <div className="mb-4 px-3 py-2 rounded-md bg-destructive/10 border border-destructive/20 text-xs text-destructive">
            {vscodeDiffError}
            <button
              onClick={() => setVscodeDiffError(null)}
              className="ml-2 text-destructive/60 hover:text-destructive"
            >
              dismiss
            </button>
          </div>
        )}

        {/* Diff content */}
        {diffMode === "clean" ? (
          <PlanCleanDiffView blocks={diffBlocks} />
        ) : (
          <PlanRawDiffView blocks={diffBlocks} />
        )}
      </article>
    </div>
  );
};
