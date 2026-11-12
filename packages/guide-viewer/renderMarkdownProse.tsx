import React from 'react';
import { renderInlineMarkdown, type GuideLinkRenderer } from './renderInlineMarkdown';

const HEADING = /^#{1,6} (.*)$/;

export function renderMarkdownProse(
  text: string,
  opts?: {
    tone?: 'foreground' | 'muted';
    renderLink?: GuideLinkRenderer;
  },
): React.ReactNode[] {
  if (!text) return [];
  const inline = (t: string) => renderInlineMarkdown(t, opts?.renderLink ? { renderLink: opts.renderLink } : undefined);
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
      i = j + 1;
      continue;
    }

    const calloutOpener = line.match(/^>\s*\[!(IMPORTANT|NOTE|WARNING)\]\s*(.*)$/i);
    if (calloutOpener) {
      const type = calloutOpener[1].toLowerCase() as 'important' | 'note' | 'warning';
      const calloutLines: string[] = [];
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
          <span className="leading-relaxed">{inline(calloutLines.join(' '))}</span>
        </div>
      );
      i = j;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      nodes.push(
        <h3 key={key++} className="text-[12px] font-semibold text-foreground mt-3 mb-1">
          {inline(heading[1])}
        </h3>
      );
      i++;
      continue;
    }

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
              {inline(b)}
            </li>
          ))}
        </ul>
      );
      i = j;
      continue;
    }

    const paraLines: string[] = [line];
    let j = i + 1;
    while (
      j < lines.length &&
      lines[j].trim() &&
      !HEADING.test(lines[j]) &&
      !lines[j].match(/^[-*] /) &&
      !lines[j].match(/^>\s*\[!/) &&
      !lines[j].trimStart().startsWith('```')
    ) {
      paraLines.push(lines[j]);
      j++;
    }
    nodes.push(
      <p key={key++} className={`text-[13px] ${bodyText} leading-relaxed`}>
        {inline(paraLines.join(' '))}
      </p>
    );
    i = j;
  }

  return nodes;
}
