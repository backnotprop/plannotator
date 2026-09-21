import React from 'react';
import { renderInlineMarkdown } from './renderInlineMarkdown';

/**
 * Renders a block of markdown-ish prose (paragraphs, `### ` headings, `- `/`* `
 * bullet lists, and `> [!NOTE|IMPORTANT|WARNING]` callouts) into React nodes,
 * with inline markdown (bold/italic/code/links) handled per-line via
 * {@link renderInlineMarkdown}.
 *
 * Originally written for Code Tour stop details; shared with Guided Review
 * section overviews since both are short agent-authored prose blocks that
 * don't warrant pulling in a full markdown renderer.
 */
export function renderMarkdownProse(
  text: string,
  opts?: {
    /** 'muted' renders paragraph/bullet text in muted-foreground — used by
     *  Guided Review's narrow overview column; Tour keeps the default. */
    tone?: 'foreground' | 'muted';
  },
): React.ReactNode[] {
  if (!text) return [];
  const bodyText = opts?.tone === 'muted' ? 'text-muted-foreground' : 'text-foreground';
  const nodes: React.ReactNode[] = [];
  const lines = text.split('\n');
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code block: ``` ... ``` — must be handled at block level, before
    // paragraph collection joins lines with spaces and destroys the newlines.
    if (line.trimStart().startsWith('```')) {
      const codeLines: string[] = [];
      let j = i + 1;
      while (j < lines.length && !lines[j].trimStart().startsWith('```')) {
        codeLines.push(lines[j]);
        j++;
      }
      nodes.push(
        <pre key={key++} className="my-2 overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 font-mono text-[11px]">
          <code>{codeLines.join('\n')}</code>
        </pre>
      );
      i = j + 1; // skip the closing fence (or run off the end for an unclosed one)
      continue;
    }

    // Callout block: > [!IMPORTANT] / > [!NOTE] / > [!WARNING]
    const calloutOpener = line.match(/^>\s*\[!(IMPORTANT|NOTE|WARNING)\]\s*(.*)$/i);
    if (calloutOpener) {
      // Type comes from the [!TAG] capture, NOT a whole-line scan — with
      // same-line message text, `> [!NOTE] this is important` would otherwise
      // scan-match "important" and mistype the callout.
      const type = calloutOpener[1].toLowerCase() as 'important' | 'note' | 'warning';
      const calloutLines: string[] = [];
      // The opener's own remainder (single-line form: `> [!NOTE] message`) is
      // the mainline path — our guide prompt tells the model to emit this
      // form — so it must be captured here, not just subsequent `>` lines.
      if (calloutOpener[2]) calloutLines.push(calloutOpener[2]);
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith('>')) {
        calloutLines.push(lines[j].replace(/^>\s?/, ''));
        j++;
      }
      const calloutStyles = {
        important: 'bg-primary/[0.05] dark:bg-primary/[0.12] text-foreground',
        warning: 'bg-warning/[0.05] dark:bg-warning/[0.12] text-foreground',
        note: 'bg-muted/20 dark:bg-muted/40 text-foreground',
      };
      const calloutLabel = { important: 'Important', warning: 'Warning', note: 'Note' };
      nodes.push(
        <div key={key++} className={`my-2 px-3 py-2 rounded text-[12px] ${calloutStyles[type]}`}>
          <span className="font-semibold text-[10px] uppercase tracking-wider block mb-0.5 opacity-70">
            {calloutLabel[type]}
          </span>
          <span className="leading-relaxed">{renderInlineMarkdown(calloutLines.join(' '))}</span>
        </div>
      );
      i = j;
      continue;
    }

    // Heading h3 — inline markdown applies here too (the guide prompt
    // encourages backticked symbols/file names, including in headings).
    if (line.startsWith('### ')) {
      nodes.push(
        <h3 key={key++} className="text-[12px] font-semibold text-foreground mt-3 mb-1">
          {renderInlineMarkdown(line.slice(4))}
        </h3>
      );
      i++;
      continue;
    }

    // Bullet list
    if (line.match(/^[-*] /)) {
      const bullets: string[] = [line.slice(2)];
      let j = i + 1;
      while (j < lines.length && lines[j].match(/^[-*] /)) {
        bullets.push(lines[j].slice(2));
        j++;
      }
      nodes.push(
        <ul key={key++} className="my-1.5 space-y-0.5 pl-4">
          {bullets.map((b, bi) => (
            <li key={bi} className={`text-[13px] ${bodyText} list-disc leading-relaxed`}>
              {renderInlineMarkdown(b)}
            </li>
          ))}
        </ul>
      );
      i = j;
      continue;
    }

    // Paragraph — collect until blank line or block element
    const paraLines: string[] = [line];
    let j = i + 1;
    while (
      j < lines.length &&
      lines[j].trim() &&
      !lines[j].startsWith('### ') &&
      !lines[j].match(/^[-*] /) &&
      !lines[j].match(/^>\s*\[!/) &&
      !lines[j].trimStart().startsWith('```')
    ) {
      paraLines.push(lines[j]);
      j++;
    }
    nodes.push(
      <p key={key++} className={`text-[13px] ${bodyText} leading-relaxed`}>
        {renderInlineMarkdown(paraLines.join(' '))}
      </p>
    );
    i = j;
  }

  return nodes;
}
