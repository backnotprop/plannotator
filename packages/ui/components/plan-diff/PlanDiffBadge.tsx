/**
 * PlanDiffBadge — The +/- change badge
 *
 * Sits in the repo info area of the document card (top-left).
 * Shows addition/deletion counts and toggles plan diff view when clicked.
 */

import React from "react";
import type { PlanDiffStats } from "../../utils/planDiffEngine";

interface PlanDiffBadgeProps {
  stats: PlanDiffStats | null;
  isActive: boolean;
  onToggle: () => void;
  hasPreviousVersion: boolean;
  /**
   * Optional baseline context for surfaces whose diff baseline is NOT "the
   * previous plan revision" — annotate/folder sessions pass "since last
   * review" so the counts read against the right baseline (not, e.g., the
   * git uncommitted-vs-HEAD numbers shown elsewhere). Rendered as a short
   * muted suffix after the counts. Plan review passes nothing and renders
   * exactly as before.
   */
  baselineLabel?: string;
  /** Tooltip override for the inactive state, paired with `baselineLabel`
   *  (e.g. "Changes since you last reviewed this file"). */
  baselineTooltip?: string;
}

export const PlanDiffBadge: React.FC<PlanDiffBadgeProps> = ({
  stats,
  isActive,
  onToggle,
  hasPreviousVersion,
  baselineLabel,
  baselineTooltip,
}) => {
  if (!hasPreviousVersion || !stats) return null;

  const hasChanges = stats.additions > 0 || stats.deletions > 0 || stats.modifications > 0;
  if (!hasChanges) return null;

  return (
    <button
      onClick={onToggle}
      className={`px-1.5 py-0.5 rounded text-[9px] font-mono transition-colors cursor-pointer ${
        isActive
          ? "bg-primary/15"
          : "bg-muted/50 hover:bg-muted"
      }`}
      title={
        isActive
          ? "Exit plan diff view"
          : baselineTooltip ?? "Show what changed from previous version"
      }
    >
      <span className={isActive ? "text-success" : "text-success/70"}>
        +{stats.additions}
      </span>
      <span className="text-muted-foreground/50 mx-0.5">/</span>
      <span className={isActive ? "text-destructive" : "text-destructive/70"}>
        -{stats.deletions}
      </span>
      {baselineLabel && (
        <span className="text-muted-foreground/60 ml-1">{baselineLabel}</span>
      )}
    </button>
  );
};
