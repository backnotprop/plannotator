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

/* Design-system spec: .dot is 14px with 3px border */
const STATUS_DOT: Record<MilestoneStatus, string> = {
  done:    'bg-success border-success',
  warn:    'bg-warning border-warning',
  blocked: 'bg-destructive border-destructive',
  default: 'border-primary bg-card',
};

const STATUS_LINE: Record<MilestoneStatus, string> = {
  done:    'bg-success/30',
  warn:    'bg-warning/30',
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
 * - Lines that are only backtick-wrapped text become tags.
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
      className="directive-milestone flex relative"
      style={{ gap: '18px' }}
      data-block-id={blockId}
      data-block-type="directive"
      data-directive-kind="milestone"
    >
      {/* Timeline track — design-system spec: 14px dot, 3px border, 2px line */}
      <div className="flex flex-col items-center" style={{ paddingTop: '4px' }}>
        <div
          className={`rounded-full shrink-0 ${dotClass}`}
          style={{ width: '14px', height: '14px', borderWidth: '3px', borderStyle: 'solid' }}
        />
        <div className={`flex-1 ${lineClass}`} style={{ width: '2px', marginTop: '4px' }} />
      </div>

      {/* Content — design-system spec: h3 is font-display 1.15rem, p is 0.88rem */}
      <div style={{ paddingBottom: '36px' }}>
        {title && (
          <div style={{
            fontFamily: 'var(--font-sans)',
            fontSize: '1rem',
            fontWeight: 600,
            marginBottom: '4px',
          }}>
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
          <div className="text-muted-foreground" style={{
            fontSize: '0.88rem',
            lineHeight: 1.55,
            maxWidth: '620px',
            marginBottom: '10px',
          }}>
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
          <div className="flex flex-wrap" style={{ gap: '6px', marginTop: '8px' }}>
            {tags.map((tag, i) => (
              <span
                key={i}
                className="bg-muted text-muted-foreground"
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.68rem',
                  padding: '2px 8px',
                  borderRadius: 'calc(var(--radius, 0.625rem) - 4px)',
                  border: '1px solid var(--border)',
                }}
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
