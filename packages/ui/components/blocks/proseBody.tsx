import React from 'react';
import { InlineMarkdown } from '../InlineMarkdown';

// Shared block-level renderer for alert and directive bodies. Handles
// paragraphs, unordered lists, and ordered lists — the shapes GitHub alerts
// and Docusaurus / VitePress directives commonly carry. More exotic content
// (headings, tables, code fences, nested alerts) falls back to inline text;
// add cases here when a real use case turns up.
//
// Paragraph lines are joined with '\n' (not ' ') so InlineMarkdown's hard
// line-break handling still fires for `  \n` inside a callout body.
export function renderProseBody(args: {
  body: string;
  paragraphClassName?: string;
  listClassName?: string;
  imageBaseDir?: string;
  onImageClick?: (src: string, alt: string) => void;
  onOpenLinkedDoc?: (path: string) => void;
  onNavigateAnchor?: (hash: string) => void;
  githubRepo?: string;
}): React.ReactNode {
  const {
    body,
    paragraphClassName = 'text-[15px] leading-relaxed text-foreground/90',
    listClassName = 'text-[15px] leading-relaxed text-foreground/90',
    imageBaseDir,
    onImageClick,
    onOpenLinkedDoc,
    onNavigateAnchor,
    githubRepo,
  } = args;

  const inline = (text: string) => (
    <InlineMarkdown
      imageBaseDir={imageBaseDir}
      onImageClick={onImageClick}
      text={text}
      onOpenLinkedDoc={onOpenLinkedDoc}
      onNavigateAnchor={onNavigateAnchor}
      githubRepo={githubRepo}
    />
  );

  const lines = body.split('\n');
  const out: React.ReactNode[] = [];
  let paraLines: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let key = 0;

  const flushPara = () => {
    if (paraLines.length === 0) return;
    const text = paraLines.join('\n');
    if (text.trim()) {
      out.push(
        <p key={`p-${key++}`} className={`${paragraphClassName} ${out.length > 0 ? 'mt-2' : ''}`}>
          {inline(text)}
        </p>,
      );
    }
    paraLines = [];
  };
  const flushList = () => {
    if (!list) return;
    const Tag = list.ordered ? 'ol' : 'ul';
    const className = `${list.ordered ? 'list-decimal' : 'list-disc'} pl-5 ${listClassName} ${out.length > 0 ? 'mt-2' : ''}`;
    out.push(
      <Tag key={`l-${key++}`} className={className}>
        {list.items.map((item, i) => (
          <li key={i} className="my-0.5">{inline(item)}</li>
        ))}
      </Tag>,
    );
    list = null;
  };

  for (const line of lines) {
    if (line.trim() === '') {
      flushPara();
      flushList();
      continue;
    }
    const listMatch = line.match(/^\s*(\*|-|\d+\.)\s+(.*)$/);
    if (listMatch) {
      flushPara();
      const ordered = /\d/.test(listMatch[1]);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(listMatch[2]);
    } else {
      flushList();
      paraLines.push(line);
    }
  }
  flushPara();
  flushList();
  return out;
}
