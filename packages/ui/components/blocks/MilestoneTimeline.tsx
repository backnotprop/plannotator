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

const STATUS_DOT: Record<MilestoneStatus, string> = {
  done: 'bg-success border-success/40',
  warn: 'bg-warning border-warning/40',
  blocked: 'bg-destructive border-destructive/40',
  default: 'border-primary/50 bg-transparent',
};

const STATUS_LINE: Record<MilestoneStatus, string> = {
  done: 'bg-success/30',
  warn: 'bg-warning/30',
  blocked: 'bg-destructive/30',
  default: 'bg-border',
};

function parseStatus(raw?: string): MilestoneStatus {
  if (!raw) return 'default';
  const s = raw.toLowerCase().trim();
  if (s === 'done') return 'done';
  if (s === 'warn') return 'warn';
  if (s === 'blocked') return 'blocked';
  return 'default';
}

/**
 * Parse the milestone body into title, prose paragraphs, and tag chips.
 * - First `### heading` line becomes the title.
 * - Lines that are only backtick-wrapped text (e.g. `backend-api`) become tags.
 * - Everything else is prose.
 */
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
  blockId,
  body,
  status: rawStatus,
  imageBaseDir,
  onImageClick,
  onOpenLinkedDoc,
  onOpenCodeFile,
  githubRepo,
  onNavigateAnchor,
}) => {
  const status = parseStatus(rawStatus);
  const { title, prose, tags } = parseMilestoneBody(body);
  const dotClass = STATUS_DOT[status];
  const lineClass = STATUS_LINE[status];

  return (
    <div
      className="directive-milestone flex gap-4 my-1 relative"
      data-block-id={blockId}
      data-block-type="directive"
      data-directive-kind="milestone"
    >
      {/* Timeline track */}
      <div className="flex flex-col items-center pt-1">
        <div className={`w-3 h-3 rounded-full border-2 shrink-0 ${dotClass}`} />
        <div className={`w-0.5 flex-1 mt-1 ${lineClass}`} />
      </div>

      {/* Content */}
      <div className="pb-4 min-w-0">
        {title && (
          <div className="font-semibold text-[15px] text-foreground/90">
            <InlineMarkdown
              text={title}
              imageBaseDir={imageBaseDir}
              onImageClick={onImageClick}
              onOpenLinkedDoc={onOpenLinkedDoc}
              onOpenCodeFile={onOpenCodeFile}
              githubRepo={githubRepo}
              onNavigateAnchor={onNavigateAnchor}
            />
          </div>
        )}
        {prose.length > 0 && (
          <div className="text-sm text-muted-foreground mt-1 leading-relaxed">
            <InlineMarkdown
              text={prose.join(' ')}
              imageBaseDir={imageBaseDir}
              onImageClick={onImageClick}
              onOpenLinkedDoc={onOpenLinkedDoc}
              onOpenCodeFile={onOpenCodeFile}
              githubRepo={githubRepo}
              onNavigateAnchor={onNavigateAnchor}
            />
          </div>
        )}
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {tags.map((tag, i) => (
              <span
                key={i}
                className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-mono bg-muted text-muted-foreground border border-border/40"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
