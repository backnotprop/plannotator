/**
 * PlanDiffModeSwitcher — Toggle between clean/rendered and raw diff views
 *
 * Follows the same visual pattern as ModeSwitcher.
 */

import React from "react";

export type PlanDiffMode = "clean" | "classic" | "raw";

interface PlanDiffModeSwitcherProps {
  mode: PlanDiffMode;
  onChange: (mode: PlanDiffMode) => void;
}

export const PlanDiffModeSwitcher: React.FC<PlanDiffModeSwitcherProps> = ({
  mode,
  onChange,
}) => {
  return (
    <div className="inline-flex items-center bg-muted/50 rounded-lg p-0.5 border border-border/30">
      <button
        onClick={() => onChange("clean")}
        title="Word-level inline diff (experimental)"
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all ${
          mode === "clean"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground"
        }`}
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
            d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"
          />
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
          />
        </svg>
        Rendered
        <span className="text-[9px] uppercase tracking-wider opacity-60 ml-0.5">
          exp
        </span>
      </button>
      <button
        onClick={() => onChange("classic")}
        title="Block-level stacked diff (old above new)"
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all ${
          mode === "classic"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground"
        }`}
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
            d="M4 6h16M4 12h16M4 18h16"
          />
        </svg>
        Classic
      </button>
      <button
        onClick={() => onChange("raw")}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-all ${
          mode === "raw"
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground"
        }`}
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
            d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5"
          />
        </svg>
        Raw
      </button>
    </div>
  );
};
