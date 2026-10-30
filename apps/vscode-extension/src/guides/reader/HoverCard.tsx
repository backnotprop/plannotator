import React, { useEffect, useState } from "react";
import { renderMarkdownProse } from "@plannotator/guide-viewer/renderMarkdownProse";
import type { DiffPosition, HoverAnswer, NavigateAction } from "../reader-protocol";
import { requestReferences } from "./bridge";

/**
 * What the Guide tab's hover card shows, drawn inside the review app's
 * `TokenHoverCard` (its placement, pointer grace and scroll behavior): the
 * language server's hover for the token (signature, then docs), where the
 * symbol is defined, the guide's own line ("Changed in Chapter 1 · …"), and
 * Go to definition / Find references / Open in editor. The references count
 * arrives after the card, since a references search can take a while.
 */
export function HoverCardContent({
  answer,
  at,
  mod,
  onNavigate,
  onOpenDefinition,
}: {
  answer: HoverAnswer;
  at: DiffPosition;
  /** "⌘" or "Ctrl". */
  mod: string;
  onNavigate: (action: NavigateAction) => void;
  onOpenDefinition: () => void;
}) {
  const [refs, setRefs] = useState<number | null>(answer.referenceCount);
  useEffect(() => {
    let live = true;
    if (answer.referenceCount === null && answer.definition) void requestReferences(at).then((n) => live && setRefs(n));
    return () => {
      live = false;
    };
  }, [answer, at]);

  const def = answer.definition;
  return (
    <div className="pn-hover text-[12.5px]" data-reader-hover-card>
      {answer.blocks.map((block, i) =>
        block.kind === "code" ? (
          <pre key={i} className="pn-hover-code m-0 overflow-x-auto whitespace-pre-wrap border-b border-border px-3.5 py-2.5 font-mono text-[12px] leading-relaxed text-foreground">
            {block.text}
          </pre>
        ) : (
          <div key={i} className="space-y-1.5 border-b border-border px-3.5 py-2.5 text-[12.5px] leading-relaxed">
            {renderMarkdownProse(block.text, { tone: "muted" })}
          </div>
        ),
      )}
      {answer.stale && (
        <p className="border-b border-border px-3.5 py-1.5 text-[11.5px] text-muted-foreground">The file changed since the guide was written; this is the hover for the nearest match.</p>
      )}
      {(answer.chapter || def) && (
        <div className="border-b border-border px-3.5 py-2 text-[12px] text-muted-foreground">
          {answer.chapter && (
            <div className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 flex-shrink-0 rounded-full" style={{ background: answer.chapter.color }} aria-hidden="true" />
              <span>
                Changed in{" "}
                <strong className="font-semibold text-foreground">
                  Chapter {answer.chapter.n} · {answer.chapter.title}
                </strong>
              </span>
              {answer.chapter.reviewed && <span className="text-success">✓ reviewed</span>}
            </div>
          )}
          {def && (
            <div className={`truncate font-mono text-[11px] ${answer.chapter ? "mt-1" : ""}`}>
              {def.path}:{def.line}
            </div>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3.5 py-2 text-[12px]">
        <button type="button" className="text-primary hover:underline" onClick={() => onNavigate("definition")}>
          Go to definition <span className="text-muted-foreground">F12</span>
        </button>
        <button type="button" className="text-primary hover:underline" onClick={() => onNavigate("references")}>
          Find references{refs !== null ? ` (${refs})` : ""} <span className="text-muted-foreground">⇧F12</span>
        </button>
        {def?.inRepo && (
          <button type="button" className="text-primary hover:underline" onClick={onOpenDefinition}>
            Open in editor
          </button>
        )}
      </div>
      <div className="border-t border-border px-3.5 py-1 text-[10.5px] text-muted-foreground">{mod}-click a symbol to go to its definition.</div>
    </div>
  );
}
