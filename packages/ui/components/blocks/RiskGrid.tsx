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

/* Design-system spec: .badge colors via color-mix */
const SEVERITY_BADGE: Record<string, string> = {
  high: 'background: color-mix(in oklab, var(--destructive) 15%, transparent); color: var(--destructive);',
  med:  'background: color-mix(in oklab, var(--warning) 15%, transparent); color: var(--warning);',
  low:  'background: color-mix(in oklab, var(--success) 15%, transparent); color: var(--success);',
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
  const badgeStyle = (sev: string): string =>
    SEVERITY_BADGE[sev.toLowerCase()] || SEVERITY_BADGE.low;

  return (
    <div
      className="directive-risks my-4 overflow-hidden"
      style={{ border: '1.5px solid var(--border)', borderRadius: 'var(--radius, 0.625rem)' }}
      data-block-id={blockId}
      data-block-type="directive"
      data-directive-kind="risks"
    >
      {risks.map((risk, i) => (
        <div
          key={i}
          className="items-center"
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr 1.5fr',
            gap: '16px',
            padding: '14px 24px',
            borderBottom: i < risks.length - 1 ? '1px solid var(--border)' : 'none',
          }}
        >
          {/* Badge — design-system spec: font-mono, 0.68rem, weight 600, uppercase */}
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '0.68rem',
              fontWeight: 600,
              padding: '2px 8px',
              borderRadius: 'calc(var(--radius, 0.625rem) - 4px)',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              ...Object.fromEntries(
                badgeStyle(risk.severity).split(';').filter(Boolean).map(s => {
                  const [k, v] = s.split(':').map(x => x.trim());
                  return [k.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v];
                })
              ),
            }}
          >
            {risk.severity}
          </span>
          {/* Name — design-system spec: weight 500 */}
          <span style={{ fontWeight: 500, fontSize: '0.9rem' }}>
            <InlineMarkdown text={risk.name} {...inlineProps} />
          </span>
          {/* Mitigation — design-system spec: 0.9rem, muted-foreground */}
          <span className="text-muted-foreground" style={{ fontSize: '0.85rem' }}>
            <InlineMarkdown text={risk.mitigation} {...inlineProps} />
          </span>
        </div>
      ))}
    </div>
  );
};
