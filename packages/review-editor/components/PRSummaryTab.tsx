import React from 'react';
import { AnnotatableDescription } from './AnnotatableDescription';
import { MarkdownBody } from './MarkdownBody';
import type { PRContext, PRMetadata } from '@plannotator/shared/pr-types';

interface PRSummaryTabProps {
  context: PRContext;
  metadata: PRMetadata;
}
export const PRSummaryTab: React.FC<PRSummaryTabProps> = React.memo(({ context, metadata }) => {
  return (
    <div className="px-8 py-4 space-y-4 max-w-2xl">
      {/* PR title + state */}
      <div className="space-y-2">
        <div className="flex items-start gap-2">
          <span className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded ${
            context.state === 'MERGED'
              ? 'bg-violet-500/15 text-violet-400'
              : context.state === 'CLOSED'
                ? 'bg-destructive/15 text-destructive'
                : context.isDraft
                  ? 'bg-muted text-muted-foreground'
                  : 'bg-success/15 text-success'
          }`}>
            {context.isDraft ? 'Draft' : context.state}
          </span>
          <a
            href={metadata.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-foreground hover:text-primary transition-colors"
          >
            {metadata.title}
          </a>
        </div>

        <div className="text-[10px] text-muted-foreground font-mono">
          {metadata.author} wants to merge <code className="bg-muted px-1 rounded">{metadata.headBranch}</code> into <code className="bg-muted px-1 rounded">{metadata.baseBranch}</code>
        </div>
        {metadata.defaultBranch && metadata.baseBranch !== metadata.defaultBranch && (
          <div className="inline-flex items-center gap-1.5 rounded border border-accent/20 bg-accent/10 px-2 py-1 text-[10px] text-accent">
            <span className="font-medium uppercase tracking-wide">Stacked</span>
            <span className="text-accent/80">
              Diffs against <code className="font-mono">{metadata.baseBranch}</code>, default branch is <code className="font-mono">{metadata.defaultBranch}</code>
            </span>
          </div>
        )}
      </div>

      {/* Labels */}
      {context.labels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {context.labels.map((label) => (
            <span
              key={label.name}
              className="text-[10px] px-1.5 py-0.5 rounded-full font-medium text-foreground"
              style={{
                backgroundColor: `#${label.color}18`,
                border: `1px solid #${label.color}50`,
              }}
            >
              {label.name}
            </span>
          ))}
        </div>
      )}

      {/* Linked issues */}
      {context.linkedIssues.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Linked Issues
          </h3>
          {context.linkedIssues.map((issue) => (
            <a
              key={issue.url}
              href={issue.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs text-primary hover:underline"
            >
              <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 896 1024" fill="currentColor">
                <path d="M448 64C200.562 64 0 264.562 0 512c0 247.438 200.562 448 448 448 247.438 0 448-200.562 448-448C896 264.562 695.438 64 448 64zM448 832c-176.781 0-320-143.25-320-320 0-176.781 143.219-320 320-320 176.75 0 320 143.219 320 320C768 688.75 624.75 832 448 832zM384 768h128V640H384V768zM384 576h128V256H384V576z" />
              </svg>
              #{issue.number}
              {issue.repo && <span className="text-muted-foreground text-[10px]">({issue.repo})</span>}
            </a>
          ))}
        </div>
      )}

      {/* PR body */}
      {context.body ? (
        <div className="space-y-1">
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Description
          </h3>
          <AnnotatableDescription markdown={context.body} className="md-compact" />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground italic">No description provided.</p>
      )}
    </div>
  );
});

