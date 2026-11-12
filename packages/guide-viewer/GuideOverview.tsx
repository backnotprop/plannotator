import React from 'react';
import type { GuideOverview as GuideOverviewData } from '@plannotator/core/guide';
import { useGuideHost } from './host';
import { renderMarkdownProse } from './renderMarkdownProse';
import type { GuideLinkRenderer } from './renderInlineMarkdown';

export const GuideOverview: React.FC<{
  overview: GuideOverviewData;
  renderLink: GuideLinkRenderer;
  plain?: boolean;
}> = ({ overview, renderLink, plain = false }) => {
  const host = useGuideHost();
  const diagram = overview.diagram;
  const drawn = diagram ? host.renderOverviewDiagram?.(diagram) ?? null : null;
  return (
    <section data-guide-overview aria-label="Overview" className={plain ? 'gv-overview' : 'mt-6'}>
      {!plain && <h2 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">Overview</h2>}
      <div className={plain ? 'gv-prose' : 'mt-2 max-w-[72ch] space-y-2.5'}>{renderMarkdownProse(overview.text, { renderLink })}</div>
      {diagram && (
        <div data-guide-overview-diagram={diagram.kind} className="mt-4">
          {drawn ??
            (diagram.kind === 'mermaid' ? (
              <pre className="overflow-x-auto whitespace-pre rounded-md bg-muted/50 p-3 font-mono text-[11px] text-muted-foreground">
                <code>{diagram.source}</code>
              </pre>
            ) : (
              <p className="text-[12px] text-muted-foreground">This guide's overview has a custom picture, which this viewer does not draw.</p>
            ))}
        </div>
      )}
    </section>
  );
};
