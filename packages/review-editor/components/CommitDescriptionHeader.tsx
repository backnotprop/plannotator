import React, { useState } from 'react';
import type { CommitDiffInfo } from '@plannotator/shared/types';
import { Avatar } from './Avatar';
import { MarkdownBody } from './MarkdownBody';
import { formatRelativeTime } from '@plannotator/ui/utils/aiChatFormat';

/**
 * The commit description heading the all-files view while a `commit:<sha>`
 * diff is on screen: subject, author (avatar + name), sha, age, and the full
 * message body rendered as markdown — the same renderer the PR viewer uses.
 *
 * Rendered as the all-files surface's leadingContent, so it scrolls away with
 * the diff (not pinned). The body shows in full; only genuinely huge bodies
 * get a CSS clamp with a Show more toggle (clamping via max-height keeps the
 * markdown intact — no mid-block truncation). Key the component by sha so the
 * toggle resets per commit.
 */

/** Bodies past this many rendered lines (rough) get the Show more clamp. */
const LONG_BODY_LINES = 24;
const LONG_BODY_CHARS = 1800;

export const CommitDescriptionHeader: React.FC<{ info: CommitDiffInfo }> = ({ info }) => {
  const [expanded, setExpanded] = useState(false);
  const isLong =
    info.body.split('\n').length > LONG_BODY_LINES || info.body.length > LONG_BODY_CHARS;
  const clamped = isLong && !expanded;

  return (
    <div className="border-b border-border/50 bg-card/30">
      <div className="px-4 pt-3 pb-3">
        <div className="text-sm font-semibold leading-snug break-words">{info.subject}</div>
        <div className="mt-1.5 flex items-center gap-2 min-w-0 text-xs text-muted-foreground">
          <Avatar src={info.avatarUrl} name={info.author} size={18} />
          <span className="truncate">{info.author}</span>
          <span className="font-mono text-[11px]" title={info.sha}>{info.shortSha}</span>
          <span className="text-muted-foreground/70">{formatRelativeTime(info.committedAt)}</span>
        </div>
        {info.body && (
          <>
            <div
              className={`mt-3 ${
                clamped
                  ? 'max-h-48 overflow-hidden [mask-image:linear-gradient(to_bottom,black_72%,transparent)]'
                  : ''
              }`}
            >
              <MarkdownBody markdown={info.body} />
            </div>
            {isLong && (
              <button
                onClick={() => setExpanded((v) => !v)}
                className="mt-1.5 text-[11px] text-primary/80 underline underline-offset-2 decoration-primary/40 hover:text-primary transition-colors"
              >
                {expanded ? 'Show less' : 'Show more'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
};
