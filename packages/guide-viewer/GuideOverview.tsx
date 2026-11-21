import React from 'react';
import type { GuideOverview as GuideOverviewData } from '@plannotator/core/guide';
import { useGuideHost } from './host';
import { renderMarkdownProse } from './renderMarkdownProse';
import type { GuideLinkRenderer } from './renderInlineMarkdown';

/**
 * The agent's overview above the chapters (snapshot format version 2): a few
 * sentences on how the change fits together, with links into code, and
 * optionally one diagram. The diagram is drawn by the host
 * (`GuideHostValue.renderOverviewDiagram`); without one, Mermaid shows as its
 * source and an HTML picture as a short note. No agent markup is ever put in
 * the page here: prose goes through the inline markdown renderer, a diagram's
 * source is text.
 */
export const GuideOverview: React.FC<{
  overview: GuideOverviewData;
  renderLink: GuideLinkRenderer;
  /** No "Overview" label above the prose (GuideView `threadHeading`: the host's chapter menu names it). The host styles `gv-` names. */
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
