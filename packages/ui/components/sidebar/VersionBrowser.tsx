/**
 * VersionBrowser — Version list + plan browser
 *
 * Shows all versions of the current plan and allows selecting
 * which version to diff against.
 */

import React, { useEffect, useState } from "react";
import type { VersionInfo, VersionEntry, ProjectPlan } from "../../hooks/usePlanDiff";

interface VersionBrowserProps {
  versionInfo: VersionInfo | null;
  versions: VersionEntry[];
  projectPlans: ProjectPlan[];
  selectedBaseVersion: number | null;
  onSelectBaseVersion: (version: number) => void;
  isPlanDiffActive: boolean;
  hasPreviousVersion: boolean;
  onActivatePlanDiff: () => void;
  isLoading: boolean;
  isSelectingVersion: boolean;
  fetchingVersion: number | null;
  onFetchVersions: () => void;
  onFetchProjectPlans: () => void;
}

/**
 * Format a timestamp as a relative time string.
 */
function relativeTime(timestamp: string): string {
  if (!timestamp) return "";
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diff = now - then;

  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

export const VersionBrowser: React.FC<VersionBrowserProps> = ({
  versionInfo,
  versions,
  projectPlans,
  selectedBaseVersion,
  onSelectBaseVersion,
  isPlanDiffActive,
  hasPreviousVersion,
  onActivatePlanDiff,
  isLoading,
  isSelectingVersion,
  fetchingVersion,
  onFetchVersions,
  onFetchProjectPlans,
}) => {
  const [showOtherPlans, setShowOtherPlans] = useState(false);

  // Fetch version list once versionInfo is available
  useEffect(() => {
    if (versionInfo && versions.length === 0) {
      onFetchVersions();
    }
  }, [versionInfo, versions.length, onFetchVersions]);

  if (!versionInfo) {
    return (
      <div className="p-4 text-xs text-muted-foreground text-center">
        No version history available.
      </div>
    );
  }

  const currentVersion = versionInfo.version;
  const totalVersions = versionInfo.totalVersions;

  return (
    <div className="p-3">
      {/* Current version info */}
      <div className="mb-3">
        <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1">
          Current Plan
        </div>
        <div className="text-xs text-foreground">
          Version {currentVersion} of {totalVersions}
        </div>
      </div>

      {/* Show Diff button if not active */}
      {hasPreviousVersion && !isPlanDiffActive && (
        <button
          onClick={onActivatePlanDiff}
          className="w-full mb-3 px-3 py-1.5 text-xs font-medium rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors border border-primary/20"
        >
          Show Changes
        </button>
      )}

      {/* Version list */}
      {totalVersions > 1 && (
        <div className="mb-3">
          <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-2">
            Compare Against
          </div>

          {isLoading ? (
            <div className="text-xs text-muted-foreground py-2 text-center">
              Loading...
            </div>
          ) : (
            <div className="space-y-0.5">
              {versions
                .filter((v) => v.version !== currentVersion)
                .reverse()
                .map((v) => {
                  const isSelected = selectedBaseVersion === v.version;
                  return (
                    <button
                      key={v.version}
                      onClick={() => onSelectBaseVersion(v.version)}
                      className={`w-full text-left px-2 py-1.5 rounded text-xs transition-colors ${
                        isSelected
                          ? "bg-primary/10 text-primary border border-primary/30"
                          : "text-foreground hover:bg-muted/50 border border-transparent"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium">
                          v{v.version}
                          {v.version === currentVersion - 1 && (
                            <span className="ml-1 text-muted-foreground font-normal">
                              (previous)
                            </span>
                          )}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          {fetchingVersion === v.version ? "Loading..." : relativeTime(v.timestamp)}
                        </span>
                      </div>
                    </button>
                  );
                })}
            </div>
          )}
        </div>
      )}

      {/* Other plans (collapsible) */}
      <div className="border-t border-border/50 pt-2">
        <button
          onClick={() => {
            setShowOtherPlans(!showOtherPlans);
            if (!showOtherPlans && projectPlans.length === 0) {
              onFetchProjectPlans();
            }
          }}
          className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wider hover:text-foreground transition-colors"
        >
          <svg
            className={`w-2.5 h-2.5 transition-transform ${showOtherPlans ? "rotate-90" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 5l7 7-7 7"
            />
          </svg>
          Other Plans
        </button>

        {showOtherPlans && (
          <div className="mt-2 space-y-1">
            <div className="text-[10px] text-muted-foreground italic px-2 py-1.5 leading-relaxed">
              Viewing and comparing against other plans in this project is coming soon.
            </div>
            {projectPlans.length === 0 ? (
              <div className="text-xs text-muted-foreground py-1">
                No other plans found.
              </div>
            ) : (
              projectPlans.map((plan) => (
                <div
                  key={plan.slug}
                  className="px-2 py-1.5 rounded text-xs opacity-60"
                >
                  <div className="font-medium text-foreground truncate" title={plan.slug}>
                    {plan.slug.replace(/-\d{4}-\d{2}-\d{2}$/, "")}
                  </div>
                  <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-0.5">
                    <span>{plan.versions} version{plan.versions !== 1 ? "s" : ""}</span>
                    <span>{relativeTime(plan.lastModified)}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
};
