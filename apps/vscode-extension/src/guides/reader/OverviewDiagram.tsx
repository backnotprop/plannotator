import React, { useEffect, useRef, useState } from "react";
import { checkMermaid, renderMermaid, type MermaidCheck } from "../webview/diagram";
import { post } from "./bridge";

/**
 * The overview's Mermaid diagram, drawn by Plannotator's diagram engine (the
 * same render the builder's check uses). The agent's `click` lines are taken
 * out of the source and attached to the drawn nodes as guide links: a click
 * follows the link here (a chapter scrolls the reader, code and symbols go to
 * the extension). Loaded lazily: a guide without a diagram never loads Mermaid.
 */
export default function OverviewDiagram({ source, onChapter }: { source: string; onChapter: (index: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void renderMermaid(source).then((r) => {
      if (!live || !ref.current) return;
      if (!r.ok) {
        setError(`${r.message}${r.line ? ` (line ${r.line})` : ""}`);
        return;
      }
      ref.current.replaceChildren(r.svg);
    });
    return () => {
      live = false;
    };
  }, [source]);
  const follow = (target: EventTarget | null) => {
    const el = (target as Element | null)?.closest?.("[data-link]");
    const link = el?.getAttribute("data-link");
    if (!link) return false;
    const chapter = /^chapter:(\d+)$/.exec(link);
    if (chapter) onChapter(Number(chapter[1]) - 1);
    else post({ type: "link", href: link, action: "open" });
    return true;
  };
  if (error) {
    return (
      <div className="rounded-md border border-border p-3 text-[12px] text-muted-foreground">
        The diagram does not render: {error}
        <pre className="mt-2 overflow-x-auto whitespace-pre font-mono text-[11px]">{source}</pre>
      </div>
    );
  }
  return (
    <div
      ref={ref}
      className="pn-overview-diagram overflow-x-auto"
      onClick={(e) => follow(e.target)}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && follow(e.target)) e.preventDefault();
      }}
    />
  );
}

/** The builder's render check (the extension asks the open Guide tab): the same engine, off screen. */
export function checkMermaidHere(source: string): Promise<MermaidCheck> {
  return checkMermaid(source);
}
