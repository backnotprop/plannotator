/**
 * PlanRawDiffView — Raw markdown diff mode (P2 style)
 *
 * Shows the raw markdown source with +/- prefixed lines,
 * like a traditional code diff. Monospace font, line numbers,
 * colored backgrounds.
 */

import React, { useMemo } from "react";
import type { PlanDiffBlock } from "../../utils/planDiffEngine";

interface PlanRawDiffViewProps {
  blocks: PlanDiffBlock[];
}

interface DiffLine {
  type: "added" | "removed" | "unchanged";
  content: string;
  lineNumber: number | null;
}

export const PlanRawDiffView: React.FC<PlanRawDiffViewProps> = ({ blocks }) => {
  const lines = useMemo(() => {
    const result: DiffLine[] = [];
    let lineNum = 1;

    for (const block of blocks) {
      const rawLines = block.content.split("\n");
      // Remove trailing empty string from split
      if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
        rawLines.pop();
      }

      if (block.type === "modified" && block.oldContent) {
        // Show old content as removed
        const oldLines = block.oldContent.split("\n");
        if (oldLines.length > 0 && oldLines[oldLines.length - 1] === "") {
          oldLines.pop();
        }
        for (const line of oldLines) {
          result.push({ type: "removed", content: line, lineNumber: null });
        }
        // Show new content as added
        for (const line of rawLines) {
          result.push({ type: "added", content: line, lineNumber: lineNum++ });
        }
      } else if (block.type === "added") {
        for (const line of rawLines) {
          result.push({ type: "added", content: line, lineNumber: lineNum++ });
        }
      } else if (block.type === "removed") {
        for (const line of rawLines) {
          result.push({ type: "removed", content: line, lineNumber: null });
        }
      } else {
        for (const line of rawLines) {
          result.push({
            type: "unchanged",
            content: line,
            lineNumber: lineNum++,
          });
        }
      }
    }

    return result;
  }, [blocks]);

  return (
    <div className="font-mono text-[13px] leading-relaxed bg-muted/30 rounded-lg border border-border/30 overflow-x-auto">
      <div>
        {lines.map((line, index) => (
          <div
            key={index}
            className={`flex px-4 py-0.5 ${
              line.type === "added"
                ? "plan-diff-line-added"
                : line.type === "removed"
                  ? "plan-diff-line-removed"
                  : "hover:bg-muted/30"
            }`}
          >
            {/* Gutter: +/- prefix */}
            <div className="w-5 flex-shrink-0 select-none opacity-60 text-right pr-2">
              {line.type === "added"
                ? "+"
                : line.type === "removed"
                  ? "-"
                  : " "}
            </div>
            {/* Line number */}
            <div className="w-8 flex-shrink-0 select-none text-muted-foreground/40 text-right pr-3 text-[11px]">
              {line.lineNumber ?? ""}
            </div>
            {/* Content */}
            <div className="whitespace-pre-wrap break-words min-w-0">{line.content || " "}</div>
          </div>
        ))}
      </div>
    </div>
  );
};
