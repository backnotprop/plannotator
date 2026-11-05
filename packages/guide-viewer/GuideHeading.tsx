import React from 'react';
import { renderInlineMarkdown } from './renderInlineMarkdown';

/**
 * The guide's heading for a host whose own top bar names the review and lists its chapters (GuideView
 * `threadHeading`: the Inbox's review): it reads like a thread's. One title (what the change does), one quiet line
 * of facts, and the review's own actions on the title's line. The chain draws plain markup with `gv-` class names;
 * the host styles them. No other host draws this.
 */
export const GuideHeading: React.FC<{
  /** The guide's intent. Empty (All files): the actions alone, at the right of the row. */
  title: string;
  /** "Written by …", the model, the repository, the branch, the range: split by dots. */
  facts: readonly React.ReactNode[];
  /** Left to right. */
  actions: React.ReactNode;
}> = ({ title, facts, actions }) => (
  <header className="gv-head" data-guide-heading="">
    <div className="gv-head-row">
      {title ? (
        <h1 className="gv-title" dir="auto">
          {renderInlineMarkdown(title)}
        </h1>
      ) : (
        <span className="gv-title-gap" />
      )}
      {actions && <div className="gv-tools">{actions}</div>}
    </div>
    {facts.length > 0 && (
      <p className="gv-meta" data-guide-facts="">
        {facts.map((fact, index) => (
          <React.Fragment key={index}>
            {index > 0 && <span className="gv-dot" aria-hidden="true" />}
            <span>{fact}</span>
          </React.Fragment>
        ))}
      </p>
    )}
  </header>
);
