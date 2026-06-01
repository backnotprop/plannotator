import React, { useRef, useEffect, useMemo } from 'react';
import { Block } from '../../types';
import { MermaidBlock } from '../MermaidBlock';
import { GraphvizBlock } from '../GraphvizBlock';
import { isMermaidLanguage, isGraphvizLanguage } from '../diagramLanguages';
import { sanitizeBlockHtml } from '../../utils/sanitizeHtml';

interface DiagramPanelProps {
  blockId: string;
  body: string;
  caption?: string;
}

function detectContent(body: string): { type: 'svg' | 'diagram' | 'code'; content: string; language?: string } {
  const trimmed = body.trim();

  const fenceMatch = trimmed.match(/^```(\w*)\s*\n([\s\S]*?)(?:\n```\s*)?$/);
  if (fenceMatch) {
    const lang = fenceMatch[1] || undefined;
    const content = fenceMatch[2] || '';
    if (isMermaidLanguage(lang) || isGraphvizLanguage(lang)) {
      return { type: 'diagram', content, language: lang };
    }
    return { type: 'code', content, language: lang };
  }

  if (/<svg[\s>]/i.test(trimmed)) {
    return { type: 'svg', content: trimmed };
  }

  return { type: 'code', content: trimmed };
}

const SvgContent: React.FC<{ svg: string }> = ({ svg }) => {
  const ref = useRef<HTMLDivElement>(null);
  const sanitized = useMemo(() => sanitizeBlockHtml(svg), [svg]);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = sanitized;
  }, [sanitized]);

  return <div ref={ref} className="diagram-svg flex justify-center" />;
};

export const DiagramPanel: React.FC<DiagramPanelProps> = ({ blockId, body, caption }) => {
  const detected = detectContent(body);

  const syntheticBlock: Block = {
    id: blockId,
    type: 'code',
    content: detected.content,
    language: detected.language,
    order: 0,
    startLine: 0,
  };

  return (
    <div
      className="directive-diagram"
      data-block-id={blockId}
      data-block-type="directive"
      data-directive-kind="diagram"
    >
      {detected.type === 'svg' ? (
        <SvgContent svg={detected.content} />
      ) : detected.type === 'diagram' && isMermaidLanguage(detected.language) ? (
        <MermaidBlock block={syntheticBlock} />
      ) : detected.type === 'diagram' && isGraphvizLanguage(detected.language) ? (
        <GraphvizBlock block={syntheticBlock} />
      ) : (
        <pre className="font-mono text-sm overflow-x-auto leading-relaxed">
          <code className={detected.language ? `language-${detected.language}` : ''}>
            {detected.content}
          </code>
        </pre>
      )}
      {caption && <p className="diagram-caption">{caption}</p>}
    </div>
  );
};
