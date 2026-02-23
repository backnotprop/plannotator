/**
 * PlanCleanDiffView — Rendered/clean diff mode (P1 style)
 *
 * Shows the new plan content rendered as markdown, with colored left borders
 * indicating what changed:
 * - Green: added content
 * - Red: removed content (with strikethrough)
 * - Modified: old content (red, struck through) above new content (green)
 * - Unchanged: normal rendering, slightly dimmed
 *
 * Reuses parseMarkdownToBlocks() for rendering consistency with the plan view.
 */

import React, { useEffect, useRef } from "react";
import hljs from "highlight.js";
import { parseMarkdownToBlocks } from "../../utils/parser";
import type { Block } from "../../types";
import type { PlanDiffBlock } from "../../utils/planDiffEngine";

interface PlanCleanDiffViewProps {
  blocks: PlanDiffBlock[];
}

export const PlanCleanDiffView: React.FC<PlanCleanDiffViewProps> = ({
  blocks,
}) => {
  return (
    <div className="space-y-1">
      {blocks.map((block, index) => (
        <DiffBlockRenderer key={index} block={block} />
      ))}
    </div>
  );
};

const DiffBlockRenderer: React.FC<{ block: PlanDiffBlock }> = ({ block }) => {
  switch (block.type) {
    case "unchanged":
      return (
        <div className="plan-diff-unchanged opacity-60 hover:opacity-100 transition-opacity">
          <MarkdownChunk content={block.content} />
        </div>
      );

    case "added":
      return (
        <div className="plan-diff-added">
          <MarkdownChunk content={block.content} />
        </div>
      );

    case "removed":
      return <RemovedBlock content={block.content} />;

    case "modified":
      return (
        <ModifiedBlock
          content={block.content}
          oldContent={block.oldContent!}
        />
      );

    default:
      return null;
  }
};

/**
 * Removed content — always visible with red styling and strikethrough.
 */
const RemovedBlock: React.FC<{ content: string }> = ({ content }) => {
  return (
    <div className="plan-diff-removed line-through decoration-destructive/30 opacity-70">
      <MarkdownChunk content={content} />
    </div>
  );
};

/**
 * Modified content — shows old content (red, struck through) above new content (green border).
 */
const ModifiedBlock: React.FC<{
  content: string;
  oldContent: string;
}> = ({ content, oldContent }) => {
  return (
    <div>
      <div className="plan-diff-removed line-through decoration-destructive/30 opacity-60">
        <MarkdownChunk content={oldContent} />
      </div>
      <div className="plan-diff-added">
        <MarkdownChunk content={content} />
      </div>
    </div>
  );
};

/**
 * Renders a markdown string chunk using parseMarkdownToBlocks + simplified block rendering.
 * Reuses the same visual output as the Viewer component.
 */
const MarkdownChunk: React.FC<{ content: string }> = ({ content }) => {
  const blocks = React.useMemo(
    () => parseMarkdownToBlocks(content),
    [content]
  );

  return (
    <>
      {blocks.map((block) => (
        <SimpleBlockRenderer key={block.id} block={block} />
      ))}
    </>
  );
};

/**
 * Simplified block renderer — same visual output as Viewer's BlockRenderer
 * but without annotations, code block hover, or mermaid support.
 */
const SimpleBlockRenderer: React.FC<{ block: Block }> = ({ block }) => {
  switch (block.type) {
    case "heading": {
      const Tag = `h${block.level || 1}` as keyof React.JSX.IntrinsicElements;
      const styles =
        {
          1: "text-2xl font-bold mb-4 mt-6 first:mt-0 tracking-tight",
          2: "text-xl font-semibold mb-3 mt-8 text-foreground/90",
          3: "text-base font-semibold mb-2 mt-6 text-foreground/80",
        }[block.level || 1] || "text-base font-semibold mb-2 mt-4";

      return (
        <Tag className={styles}>
          <InlineMarkdown text={block.content} />
        </Tag>
      );
    }

    case "blockquote":
      return (
        <blockquote className="border-l-2 border-primary/50 pl-4 my-4 text-muted-foreground italic">
          <InlineMarkdown text={block.content} />
        </blockquote>
      );

    case "list-item": {
      const indent = (block.level || 0) * 1.25;
      const isCheckbox = block.checked !== undefined;
      return (
        <div
          className="flex gap-3 my-1.5"
          style={{ marginLeft: `${indent}rem` }}
        >
          <span className="select-none shrink-0 flex items-center">
            {isCheckbox ? (
              block.checked ? (
                <svg
                  className="w-4 h-4 text-success"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              ) : (
                <svg
                  className="w-4 h-4 text-muted-foreground/50"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <circle cx="12" cy="12" r="9" />
                </svg>
              )
            ) : (
              <span className="text-primary/60">
                {(block.level || 0) === 0
                  ? "\u2022"
                  : (block.level || 0) === 1
                    ? "\u25E6"
                    : "\u25AA"}
              </span>
            )}
          </span>
          <span
            className={`text-sm leading-relaxed ${isCheckbox && block.checked ? "text-muted-foreground line-through" : "text-foreground/90"}`}
          >
            <InlineMarkdown text={block.content} />
          </span>
        </div>
      );
    }

    case "code":
      return <SimpleCodeBlock block={block} />;

    case "hr":
      return <hr className="border-border/30 my-8" />;

    case "table": {
      const lines = block.content.split('\n').filter(line => line.trim());
      if (lines.length === 0) return null;
      const parseRow = (line: string): string[] =>
        line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
      const headers = parseRow(lines[0]);
      const rows: string[][] = [];
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (/^[\|\-:\s]+$/.test(line)) continue;
        rows.push(parseRow(line));
      }
      return (
        <div className="my-4 overflow-x-auto">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border">
                {headers.map((header, i) => (
                  <th key={i} className="px-3 py-2 text-left font-semibold text-foreground/90 bg-muted/30">
                    <InlineMarkdown text={header} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIdx) => (
                <tr key={rowIdx} className="border-b border-border/50">
                  {row.map((cell, cellIdx) => (
                    <td key={cellIdx} className="px-3 py-2 text-foreground/80">
                      <InlineMarkdown text={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    default:
      return (
        <p className="mb-4 leading-relaxed text-foreground/90 text-[15px]">
          <InlineMarkdown text={block.content} />
        </p>
      );
  }
};

/**
 * Simplified code block with syntax highlighting (no hover/copy toolbar).
 */
const SimpleCodeBlock: React.FC<{ block: Block }> = ({ block }) => {
  const codeRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (codeRef.current) {
      codeRef.current.removeAttribute("data-highlighted");
      codeRef.current.className = `hljs font-mono${block.language ? ` language-${block.language}` : ""}`;
      hljs.highlightElement(codeRef.current);
    }
  }, [block.content, block.language]);

  return (
    <div className="relative group my-5">
      <pre className="bg-muted/50 border border-border/30 rounded-lg overflow-x-auto">
        <code
          ref={codeRef}
          className={`hljs font-mono${block.language ? ` language-${block.language}` : ""}`}
        >
          {block.content}
        </code>
      </pre>
      {block.language && (
        <span className="absolute top-2 right-2 text-[9px] font-mono text-muted-foreground/50">
          {block.language}
        </span>
      )}
    </div>
  );
};

/**
 * Inline markdown renderer — handles bold, italic, inline code, links.
 * Duplicated from Viewer for self-containment.
 */
const InlineMarkdown: React.FC<{ text: string }> = ({ text }) => {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    let match = remaining.match(/^\*\*(.+?)\*\*/);
    if (match) {
      parts.push(
        <strong key={key++} className="font-semibold">
          {match[1]}
        </strong>
      );
      remaining = remaining.slice(match[0].length);
      continue;
    }

    match = remaining.match(/^\*(.+?)\*/);
    if (match) {
      parts.push(<em key={key++}>{match[1]}</em>);
      remaining = remaining.slice(match[0].length);
      continue;
    }

    match = remaining.match(/^`([^`]+)`/);
    if (match) {
      parts.push(
        <code
          key={key++}
          className="px-1.5 py-0.5 rounded bg-muted text-sm font-mono"
        >
          {match[1]}
        </code>
      );
      remaining = remaining.slice(match[0].length);
      continue;
    }

    match = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (match) {
      parts.push(
        <a
          key={key++}
          href={match[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline underline-offset-2 hover:text-primary/80"
        >
          {match[1]}
        </a>
      );
      remaining = remaining.slice(match[0].length);
      continue;
    }

    const nextSpecial = remaining.slice(1).search(/[*`[]/);
    if (nextSpecial === -1) {
      parts.push(remaining);
      break;
    } else {
      parts.push(remaining.slice(0, nextSpecial + 1));
      remaining = remaining.slice(nextSpecial + 1);
    }
  }

  return <>{parts}</>;
};
