/**
 * ReviewHistory — Sidebar panel showing previous review iterations
 *
 * Displays a timeline of deny/approve cycles with feedback summaries,
 * Q&A context, and iteration metadata. Helps maintain context across
 * multiple plan revision cycles.
 */

import React, { useState } from "react";

export interface ReviewIterationDisplay {
  iterationNumber: number;
  decision: "approved" | "denied";
  feedback: string;
  timestamp: string;
  questions?: Array<{ question: string; context?: string }>;
  answers?: Array<{ questionId: string; answer: string | string[] }>;
}

interface ReviewHistoryProps {
  sessionId: string | null;
  iterations: ReviewIterationDisplay[];
  currentIteration: number;
}

export const ReviewHistory: React.FC<ReviewHistoryProps> = ({
  sessionId,
  iterations,
  currentIteration,
}) => {
  const [expandedIteration, setExpandedIteration] = useState<number | null>(null);

  if (!sessionId || iterations.length === 0) {
    return (
      <div className="p-3 text-xs text-muted-foreground">
        <div className="flex items-center gap-2 mb-2">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 00-3.7-3.7 48.678 48.678 0 00-7.324 0 4.006 4.006 0 00-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3l-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 003.7 3.7 48.656 48.656 0 007.324 0 4.006 4.006 0 003.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3l-3 3" />
          </svg>
          <span className="font-medium">Review History</span>
        </div>
        <p className="opacity-70">No previous iterations yet. History will appear here after the first review cycle.</p>
      </div>
    );
  }

  return (
    <div className="p-2">
      <div className="flex items-center gap-2 px-1 mb-2">
        <svg className="w-3.5 h-3.5 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 00-3.7-3.7 48.678 48.678 0 00-7.324 0 4.006 4.006 0 00-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3l-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 003.7 3.7 48.656 48.656 0 007.324 0 4.006 4.006 0 003.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3l-3 3" />
        </svg>
        <span className="text-[10px] font-medium text-muted-foreground">
          Iteration {currentIteration} of {iterations.length + 1}
        </span>
      </div>

      <div className="space-y-1">
        {iterations.map((iteration) => {
          const isExpanded = expandedIteration === iteration.iterationNumber;
          const timeStr = formatRelativeTime(iteration.timestamp);
          const isDenied = iteration.decision === "denied";

          return (
            <div
              key={iteration.iterationNumber}
              className="rounded-md border border-border/50 overflow-hidden"
            >
              {/* Header — always visible */}
              <button
                onClick={() =>
                  setExpandedIteration(isExpanded ? null : iteration.iterationNumber)
                }
                className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-muted/50 transition-colors"
              >
                {/* Decision indicator */}
                <span
                  className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                    isDenied ? "bg-accent" : "bg-success"
                  }`}
                />
                <span className="text-[10px] font-medium flex-1 truncate">
                  v{iteration.iterationNumber}{" "}
                  <span className="text-muted-foreground font-normal">
                    — {isDenied ? "Revised" : "Approved"}
                  </span>
                </span>
                <span className="text-[9px] text-muted-foreground flex-shrink-0">
                  {timeStr}
                </span>
                <svg
                  className={`w-3 h-3 text-muted-foreground transition-transform ${
                    isExpanded ? "rotate-180" : ""
                  }`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </button>

              {/* Expanded content */}
              {isExpanded && (
                <div className="px-2 pb-2 border-t border-border/30">
                  {/* Feedback summary */}
                  {iteration.feedback && (
                    <div className="mt-1.5">
                      <div className="text-[9px] font-medium text-muted-foreground uppercase tracking-wider mb-0.5">
                        Feedback
                      </div>
                      <div className="text-[10px] text-foreground/80 leading-relaxed whitespace-pre-wrap line-clamp-6">
                        {truncateFeedback(iteration.feedback)}
                      </div>
                    </div>
                  )}

                  {/* Q&A pairs */}
                  {iteration.questions &&
                    iteration.questions.length > 0 &&
                    iteration.answers &&
                    iteration.answers.length > 0 && (
                      <div className="mt-1.5">
                        <div className="text-[9px] font-medium text-muted-foreground uppercase tracking-wider mb-0.5">
                          Clarifications
                        </div>
                        <div className="space-y-1">
                          {iteration.questions.map((q, idx) => {
                            const answer = iteration.answers?.find(
                              (a) => a.questionId === q.question
                            );
                            return (
                              <div
                                key={idx}
                                className="text-[10px] bg-muted/30 rounded px-1.5 py-1"
                              >
                                <div className="font-medium text-foreground/70">
                                  Q: {q.question}
                                </div>
                                {answer && (
                                  <div className="text-foreground/60 mt-0.5">
                                    A:{" "}
                                    {Array.isArray(answer.answer)
                                      ? answer.answer.join(", ")
                                      : answer.answer}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Current iteration indicator */}
      <div className="mt-2 flex items-center gap-2 px-2 py-1.5 rounded-md border border-primary/30 bg-primary/5">
        <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
        <span className="text-[10px] font-medium text-primary">
          Current review (v{currentIteration})
        </span>
      </div>
    </div>
  );
};

/** Strip the boilerplate from planDenyFeedback to show just user annotations */
function truncateFeedback(feedback: string): string {
  // Remove the standard planDenyFeedback wrapper
  const lines = feedback.split("\n");
  const userContentStart = lines.findIndex(
    (l) =>
      l.startsWith("## ") ||
      l.startsWith("- ") ||
      l.startsWith("**") ||
      (l.trim().length > 0 &&
        !l.includes("YOUR PLAN WAS NOT APPROVED") &&
        !l.includes("You MUST revise") &&
        !l.includes("address ALL of the feedback") &&
        !l.includes("IMPORTANT:"))
  );
  if (userContentStart > 0) {
    return lines.slice(userContentStart).join("\n").trim();
  }
  return feedback.slice(0, 500);
}

/** Format a timestamp as relative time */
function formatRelativeTime(timestamp: string): string {
  try {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return "just now";
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  } catch {
    return "";
  }
}
