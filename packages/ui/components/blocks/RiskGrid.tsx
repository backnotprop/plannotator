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

const SEVERITY_STYLES: Record<string, { badge: string; border: string }> = {
  high: {
    badge: 'bg-destructive/15 text-destructive border-destructive/30',
    border: 'border-l-destructive/50',
  },
  med: {
    badge: 'bg-warning/15 text-warning border-warning/30',
    border: 'border-l-warning/50',
  },
  low: {
    badge: 'bg-success/15 text-success border-success/30',
    border: 'border-l-success/50',
  },
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

function getSeverityStyle(severity: string) {
  const key = severity.toLowerCase();
  return SEVERITY_STYLES[key] || SEVERITY_STYLES.low;
}

export const RiskGrid: React.FC<RiskGridProps> = ({
  blockId,
  body,
  imageBaseDir,
  onImageClick,
  onOpenLinkedDoc,
  onOpenCodeFile,
  githubRepo,
  onNavigateAnchor,
}) => {
  const risks = parseRisks(body);
  if (risks.length === 0) return null;

  const inlineProps = { imageBaseDir, onImageClick, onOpenLinkedDoc, onOpenCodeFile, githubRepo, onNavigateAnchor };

  return (
    <div
      className="directive-risks my-4 space-y-2"
      data-block-id={blockId}
      data-block-type="directive"
      data-directive-kind="risks"
    >
      {risks.map((risk, i) => {
        const style = getSeverityStyle(risk.severity);
        return (
          <div
            key={i}
            className={`flex items-start gap-3 rounded-md border border-l-[3px] ${style.border} bg-card/50 px-3 py-2.5`}
          >
            <span
              className={`inline-flex items-center shrink-0 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border ${style.badge}`}
            >
              {risk.severity}
            </span>
            <div className="min-w-0 flex-1">
              <span className="text-sm font-medium text-foreground/90">
                <InlineMarkdown text={risk.name} {...inlineProps} />
              </span>
              {risk.mitigation && (
                <span className="text-sm text-muted-foreground ml-1">
                  — <InlineMarkdown text={risk.mitigation} {...inlineProps} />
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};
