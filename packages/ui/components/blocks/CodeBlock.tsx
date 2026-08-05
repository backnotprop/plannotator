import React, { useState, useRef, useEffect, useCallback } from 'react';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import type { Block } from '../../types';
import { copyTextToClipboard } from '../../utils/clipboard';

interface CodeBlockProps {
  block: Block;
  onHover?: (element: HTMLElement) => void;
  onLeave?: () => void;
  isHovered: boolean;
}

export const CodeBlock: React.FC<CodeBlockProps> = ({ block, onHover, onLeave }) => {
  const [copied, setCopied] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const codeRef = useRef<HTMLElement>(null);

  // Highlight code block on mount and when content/language changes.
  // Skip highlighting for language-less fences so highlight.js doesn't
  // auto-detect a language and color plain text.
  useEffect(() => {
    if (codeRef.current) {
      // Reset any previous highlighting
      codeRef.current.removeAttribute('data-highlighted');
      codeRef.current.className = `hljs font-mono${block.language ? ` language-${block.language}` : ''}`;
      if (block.language) {
        hljs.highlightElement(codeRef.current);
      }
    }
  }, [block.content, block.language]);

  const handleCopy = useCallback(async () => {
    if (await copyTextToClipboard(block.content)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      console.error('Failed to copy');
    }
  }, [block.content]);

  const handleMouseEnter = () => {
    if (containerRef.current && onHover) {
      onHover(containerRef.current);
    }
  };

  // Build className for code element
  const codeClassName = `hljs font-mono${block.language ? ` language-${block.language}` : ''}`;

  return (
    <div
      ref={containerRef}
      className="relative group my-5"
      data-block-id={block.id}
      onMouseEnter={onHover ? handleMouseEnter : undefined}
      onMouseLeave={onLeave}
    >
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 p-1.5 rounded-md bg-muted/80 hover:bg-muted text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity z-10"
        title={copied ? 'Copied!' : 'Copy code'}
      >
        {copied ? (
          <svg className="w-4 h-4 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        ) : (
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        )}
      </button>
      <pre className="rounded-lg text-[13px] overflow-x-auto bg-muted/50 border border-border/30">
        <code ref={codeRef} className={codeClassName}>{block.content}</code>
      </pre>
    </div>
  );
};
