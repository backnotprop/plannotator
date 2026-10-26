import type { InboxCardMark, InboxCardMarkState } from '@plannotator/core/inbox-types';
import { Tip } from '../components/Tip';
import { shortRef } from './model';

/**
 * A linked PR's or issue's state as a small mark, in the forge's own shapes
 * and colours (GitHub's Octicons: open, draft, merged, closed; an issue open,
 * closed or closed as not planned). Unknown (not read yet, no reader for its
 * source, a failure) is the same shape, quiet and neutral. The mark itself is
 * hidden from screen readers: the card's (or link's) name says the state.
 */

const PATHS = {
  pr: 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z',
  draft:
    'M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0-4.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z',
  merged:
    'M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z',
  closed:
    'M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z',
  issueOpen: 'M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z',
  issueDone: 'M11.28 6.78a.75.75 0 0 0-1.06-1.06L7.25 8.69 5.78 7.22a.75.75 0 0 0-1.06 1.06l2 2a.75.75 0 0 0 1.06 0l3.5-3.5ZM16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0Zm-1.5 0a6.5 6.5 0 1 0-13 0 6.5 6.5 0 0 0 13 0Z',
  issueSkip:
    'M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm9.78-2.22-5.5 5.5a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l5.5-5.5a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042Z',
} as const;

function pathOf(kind: 'pr' | 'issue', state: InboxCardMarkState): string {
  if (kind === 'issue') return state === 'completed' ? PATHS.issueDone : state === 'not_planned' ? PATHS.issueSkip : PATHS.issueOpen;
  if (state === 'merged') return PATHS.merged;
  if (state === 'closed') return PATHS.closed;
  if (state === 'draft') return PATHS.draft;
  return PATHS.pr;
}

/** The state in words, for a name or a tooltip ("merged", "closed as not planned"); null when unknown. */
export function markStateWords(kind: 'pr' | 'issue', state: InboxCardMarkState): string | null {
  switch (state) {
    case 'open':
      return 'open';
    case 'draft':
      return 'draft';
    case 'merged':
      return 'merged';
    case 'closed':
      return kind === 'pr' ? 'closed without merging' : 'closed';
    case 'completed':
      return 'closed';
    case 'not_planned':
      return 'closed as not planned';
    default:
      return null;
  }
}

/** What a card's name adds for its mark: "Pull request #12, merged" ("Issue #11" while unknown). */
export function markLabel(mark: Pick<InboxCardMark, 'kind' | 'ref' | 'state'>): string {
  const words = markStateWords(mark.kind, mark.state);
  return `${mark.kind === 'issue' ? 'Issue' : 'Pull request'} ${shortRef(mark.ref)}${words ? `, ${words}` : ''}`;
}

export function RefMarkIcon({ kind, state, size = 14 }: { kind: 'pr' | 'issue'; state: InboxCardMarkState; size?: number }) {
  return (
    <svg className="ib-refmark" data-ref-kind={kind} data-ref-state={state} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path fill="currentColor" fillRule="evenodd" d={pathOf(kind, state)} />
    </svg>
  );
}

/** A lane card's mark, with its tooltip ("#12 vite 8 for the review app · Merged"). */
export function RefMark({ mark }: { mark: InboxCardMark }) {
  const words = markStateWords(mark.kind, mark.state);
  const tip = [`${shortRef(mark.ref)}${mark.title ? ` ${mark.title}` : ''}`, words ? words[0]!.toUpperCase() + words.slice(1) : null].filter(Boolean).join(' · ');
  return (
    <Tip content={tip}>
      <span className="ib-bc-mark" data-card-mark={mark.state} data-card-mark-kind={mark.kind}>
        <RefMarkIcon kind={mark.kind} state={mark.state} />
      </span>
    </Tip>
  );
}
