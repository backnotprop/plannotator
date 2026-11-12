import React from 'react';
import { renderInlineMarkdown } from './renderInlineMarkdown';

export const GuideHeading: React.FC<{
  title: string;
  facts: readonly React.ReactNode[];
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
