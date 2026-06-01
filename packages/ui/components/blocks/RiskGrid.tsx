import React from 'react';
import { InlineMarkdown } from '../InlineMarkdown';

interface RiskGridProps {
  blockId: string;
  body: string;
  imageBaseDir?: string;
  onImageClick?: (src: string, alt: string) => void;
  onOpenLinkedDoc?: (path: string) => void;
  onOpenCodeFile?: (path: string) => void;
  githubRepo?: string;
  onNavigateAnchor?: (hash: string) => void;
}

interface RiskEntry {
  severity: string;
  name: string;
  mitigation: string;
}

const BADGE_CLASS: Record<string, string> = {
  high: 'risk-badge--high',
  med: 'risk-badge--med',
  low: 'risk-badge--low',
};

function parseRisks(body: string): RiskEntry[] {
  return body
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const parts = line.split('|').map(s => s.trim());
      return {
        severity: (parts[0] || '').toUpperCase(),
        name: parts[1] || '',
        mitigation: parts[2] || '',
      };
    });
}

export const RiskGrid: React.FC<RiskGridProps> = ({
  blockId, body,
  imageBaseDir, onImageClick, onOpenLinkedDoc, onOpenCodeFile, githubRepo, onNavigateAnchor,
}) => {
  const risks = parseRisks(body);
  if (risks.length === 0) return null;

  const inlineProps = { imageBaseDir, onImageClick, onOpenLinkedDoc, onOpenCodeFile, githubRepo, onNavigateAnchor };

  return (
    <div
      className="directive-risks my-4"
      data-block-id={blockId}
      data-block-type="directive"
      data-directive-kind="risks"
    >
      {risks.map((risk, i) => (
        <div key={i} className="risk-row">
          <span className={`risk-badge ${BADGE_CLASS[risk.severity.toLowerCase()] || BADGE_CLASS.low}`}>
            {risk.severity}
          </span>
          <span className="risk-name">
            <InlineMarkdown text={risk.name} {...inlineProps} />
          </span>
          <span className="risk-mitigation">
            <InlineMarkdown text={risk.mitigation} {...inlineProps} />
          </span>
        </div>
      ))}
    </div>
  );
};
