import React, { useState } from "react";
import type { ChapterAnswers } from "../reader-protocol";
import { post } from "./bridge";

/**
 * At the foot of a chapter's prose: "Ask about this chapter…" and the
 * chapter's answers ("Answers · N"). An answer opens as a page beside the
 * guide (the Answer tab). Without an agent to ask, only the answers show.
 */
export function ChapterAsk({ chapter, agent, busy, answers }: { chapter: number; agent: string | null; busy: boolean; answers: ChapterAnswers["items"] }) {
  const [text, setText] = useState("");
  const ask = () => {
    const question = text.trim();
    if (!question || busy) return;
    post({ type: "ask", question, chapter });
    setText("");
  };
  return (
    <div className="space-y-3" data-reader-chapter-ask={chapter}>
      {agent && (
        <form
          className="pn-ask flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            ask();
          }}
        >
          <span className="codicon codicon-sparkle flex-shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground"
            placeholder={busy ? `${agent} is answering…` : "Ask about this chapter…"}
            aria-label={`Ask ${agent} about this chapter`}
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
          />
          {text.trim() && (
            <button type="submit" className="pn-pill" disabled={busy}>
              Ask
            </button>
          )}
        </form>
      )}
      {answers.length > 0 && (
        <div>
          <div className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">Answers · {answers.length}</div>
          <ul className="space-y-1">
            {answers.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md border border-border/50 px-2.5 py-1.5 text-left hover:border-border"
                  onClick={() => post({ type: "openAnswer", id: a.id })}
                  title={a.question}
                >
                  <span className={`codicon ${a.status === "answering" ? "codicon-loading codicon-modifier-spin" : "codicon-sparkle"} flex-shrink-0 text-muted-foreground`} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">{a.question}</span>
                  <span className="flex-shrink-0 font-mono text-[10.5px] text-muted-foreground">{a.sub}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
