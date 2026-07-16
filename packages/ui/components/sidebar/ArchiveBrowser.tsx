/**
 * ArchiveBrowser — Browsable list of saved plan decisions
 *
 * Reusable in both standalone archive mode and as a sidebar tab
 * during normal plan review sessions.
 */

import React from "react";
import type { ArchivedPlan } from "@plannotator/core/storage-types";

export type { ArchivedPlan };

interface ArchiveBrowserProps {
  plans: ArchivedPlan[];
  selectedFile: string | null;
  onSelect: (filename: string) => void;
  isLoading: boolean;
}

function relativeTime(dateStr: string): string {
  if (!dateStr) return "";
  const now = Date.now();
  const then = new Date(dateStr + "T12:00:00").getTime();
  const diff = now - then;

  if (diff < 86_400_000) return "today";
  if (diff < 172_800_000) return "yesterday";
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  if (diff < 2_592_000_000) return `${Math.floor(diff / 604_800_000)}w ago`;
  return dateStr;
}

export const ArchiveBrowser: React.FC<ArchiveBrowserProps> = ({
  plans,
  selectedFile,
  onSelect,
  isLoading,
}) => {
  if (isLoading) {
    return (
      <div className="p-4 text-xs text-muted-foreground text-center">
        Loading archive...
      </div>
    );
  }

  if (plans.length === 0) {
    return (
      <div className="p-4 text-xs text-muted-foreground text-center">
        No archived plans found.
      </div>
    );
  }

  return (
    <div className="p-2">
      <div className="space-y-0.5">
        {plans.map((plan, i) => {
          const showDateHeader = i === 0 || plan.date !== plans[i - 1].date;

          const isSelected = selectedFile === plan.filename;

          return (
            <React.Fragment key={plan.filename}>
              {showDateHeader && (
                <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider px-2 pt-2 pb-1">
                  {relativeTime(plan.date)} — {plan.date}
                </div>
              )}
              <button
                onClick={() => onSelect(plan.filename)}
                className={`w-full text-left px-2 py-1.5 rounded text-xs transition-colors ${
                  isSelected
                    ? "bg-primary/10 text-primary border border-primary/30"
                    : "text-foreground hover:bg-muted/50 border border-transparent"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span
                    className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                      plan.status === "approved"
                        ? "bg-green-500"
                        : plan.status === "denied"
                          ? "bg-red-500"
                          : "bg-muted-foreground"
                    }`}
                    title={plan.status}
                  />
                  <span className="font-medium truncate">{plan.title}</span>
                </div>
              </button>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};
