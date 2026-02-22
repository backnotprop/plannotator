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
}

export const PlanDiffBadge: React.FC<PlanDiffBadgeProps> = ({
  stats,
  isActive,
  onToggle,
  hasPreviousVersion,
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
      title={isActive ? "Exit plan diff view" : "Show what changed from previous version"}
    >
      <span className={isActive ? "text-success" : "text-success/70"}>
        +{stats.additions}
      </span>
      <span className="text-muted-foreground/50 mx-0.5">/</span>
      <span className={isActive ? "text-destructive" : "text-destructive/70"}>
        -{stats.deletions}
      </span>
    </button>
  );
};
