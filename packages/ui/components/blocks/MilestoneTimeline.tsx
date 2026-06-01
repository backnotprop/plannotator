import React from 'react';
import { InlineMarkdown } from '../InlineMarkdown';

interface MilestoneTimelineProps {
  blockId: string;
  body: string;
  status?: string;
  imageBaseDir?: string;
  onImageClick?: (src: string, alt: string) => void;
  onOpenLinkedDoc?: (path: string) => void;
  onOpenCodeFile?: (path: string) => void;
  githubRepo?: string;
  onNavigateAnchor?: (hash: string) => void;
}

type MilestoneStatus = 'done' | 'warn' | 'blocked' | 'default';

function parseStatus(raw?: string): MilestoneStatus {
  if (!raw) return 'default';
  const s = raw.toLowerCase().trim();
  if (s === 'done' || s === 'warn' || s === 'blocked') return s;
  return 'default';
}

function parseMilestoneBody(body: string): {
  title: string;
  prose: string[];
  tags: string[];
} {
  const lines = body.split('\n');
  let title = '';
  const prose: string[] = [];
  const tags: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!title && trimmed.startsWith('### ')) {
      title = trimmed.replace(/^###\s*/, '');
    } else if (/^`[^`]+`$/.test(trimmed)) {
      tags.push(trimmed.slice(1, -1));
    } else if (trimmed) {
      prose.push(trimmed);
    }
  }

  return { title, prose, tags };
}

export const MilestoneTimeline: React.FC<MilestoneTimelineProps> = ({
  blockId, body, status: rawStatus,
  imageBaseDir, onImageClick, onOpenLinkedDoc, onOpenCodeFile, githubRepo, onNavigateAnchor,
}) => {
  const status = parseStatus(rawStatus);
  const { title, prose, tags } = parseMilestoneBody(body);
  const dotMod = status === 'default' ? '' : ` milestone-dot--${status}`;
  const lineMod = status === 'default' ? '' : ` milestone-line--${status}`;
  const inlineProps = { imageBaseDir, onImageClick, onOpenLinkedDoc, onOpenCodeFile, githubRepo, onNavigateAnchor };

  return (
    <div
      className="directive-milestone"
      data-block-id={blockId}
      data-block-type="directive"
      data-directive-kind="milestone"
    >
      <div className="milestone-track">
        <div className={`milestone-dot${dotMod}`} />
        <div className={`milestone-line${lineMod}`} />
      </div>
      <div className="milestone-body">
        {title && (
          <div className="milestone-title">
            <InlineMarkdown text={title} {...inlineProps} />
          </div>
        )}
        {prose.length > 0 && (
          <div className="milestone-prose">
            <InlineMarkdown text={prose.join(' ')} {...inlineProps} />
          </div>
        )}
        {tags.length > 0 && (
          <div className="milestone-tags">
            {tags.map((tag, i) => (
              <span key={i} className="milestone-tag">{tag}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
