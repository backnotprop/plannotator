import type { ReactNode } from 'react';
import type { InboxPullLink } from '@plannotator/core/inbox-types';
import { plural } from '@plannotator/core/inbox-format';
import { HostMark } from '../icons';
import { relativeWords } from '../relativeTime';
import { linkAgentName } from './model';
import { REVIEW_ROW_AUTO_STOPPED } from './reviewsModel';

export const THREAD_UNTIED_LINE = 'A thread started here, but it isn’t tied to this pull request yet.';

export interface LaunchPicturePage {
  message_id: string;
  attachment_id: string | null;
  title: string;
  at: string;
}

function Line({ kind, label, main, meta, onOpen, thread }: { kind: string; label: string; main?: ReactNode; meta?: ReactNode; onOpen?: () => void; thread?: string }) {
  const body = (
    <>
      <span className="ib-lp-line-k">{label}</span>
      <span className="ib-lp-line-v">
        {main && (
          <span className="ib-lp-line-t" dir="auto">
            {main}
          </span>
        )}
        {meta && <span className="ib-lp-line-m">{meta}</span>}
      </span>
      {onOpen && <span className="ib-lp-line-go">Open</span>}
    </>
  );
  return onOpen ? (
    <button type="button" className="ib-lp-line" onClick={onOpen} data-launch-line={kind} data-pulls-thread={thread}>
      {body}
    </button>
  ) : (
    <div className="ib-lp-line" data-launch-line={kind} data-pulls-thread={thread}>
      {body}
    </div>
  );
}

export function LaunchpadLines({
  link,
  named,
  untiedThread,
  page,
  pictureOnTheWay,
  guideOnTheWay,
  now,
  onPicture,
  onGuide,
  onThread,
}: {
  link: InboxPullLink | null;
  named: InboxPullLink | null;
  untiedThread: string | null;
  page: LaunchPicturePage | null;
  pictureOnTheWay: boolean;
  guideOnTheWay: boolean;
  now: number;
  onPicture: (threadId: string, page: LaunchPicturePage) => void;
  onGuide: (threadId: string, messageId: string) => void;
  onThread: (threadId: string) => void;
}) {
  const agentOf = (of: InboxPullLink) => (
    <>
      <HostMark host={of.agent?.host ?? null} /> {linkAgentName(of) ?? 'The agent'}
    </>
  );
  const ended = link?.agent?.ended === true;
  const guide = link?.guide?.review ? link.guide : null;
  const pictureAsked = !!link?.picture_it_asked_at && !link.picture_it_page;
  const guideAsked = !!link && link.via === 'owner' && (link.ask === 'guide' || link.ask === 'custom') && !guide;
  const pictureComing = pictureOnTheWay || (pictureAsked && !ended);
  const lines: ReactNode[] = [];
  if (link && page) {
    lines.push(
      <Line key="picture" kind="picture" label="Picture page" main={page.title} meta={pictureComing ? <>{agentOf(link)} is making a new one…</> : <>{agentOf(link)} · {relativeWords(page.at, now)}</>} onOpen={() => onPicture(link.thread_id, page)} />,
    );
  } else if (link && pictureComing) {
    lines.push(<Line key="picture" kind="picture" label="Picture page" meta={<>{agentOf(link)} is making it…</>} />);
  } else if (link && pictureAsked && ended) {
    lines.push(<Line key="picture" kind="picture" label="Picture page" meta={REVIEW_ROW_AUTO_STOPPED.picture_it} />);
  }
  if (link && guide) {
    lines.push(
      <Line
        key="guide"
        kind="guide"
        label="Guided review"
        main={guide.title}
        meta={guideOnTheWay ? <>{agentOf(link)} is writing a new one…</> : <>{plural(guide.steps, 'chapter')} · {agentOf(link)}</>}
        onOpen={() => onGuide(link.thread_id, guide.message_id)}
      />,
    );
  } else if (link && (guideOnTheWay || (guideAsked && !ended))) {
    lines.push(<Line key="guide" kind="guide" label="Guided review" meta={<>{agentOf(link)} is writing it…</>} />);
  } else if (link && guideAsked && ended) {
    lines.push(<Line key="guide" kind="guide" label="Guided review" meta={REVIEW_ROW_AUTO_STOPPED.guide} />);
  }
  const thread = link ?? named;
  if (thread) {
    lines.push(
      <Line
        key="thread"
        kind="thread"
        label="Thread"
        thread={thread.thread_id}
        main={thread.last ? `“${thread.last.preview}”` : undefined}
        meta={thread.agent?.ended ? <>{agentOf(thread)} ended</> : thread.last ? agentOf(thread) : <>{agentOf(thread)} · No answer yet</>}
        onOpen={() => onThread(thread.thread_id)}
      />,
    );
  } else if (untiedThread) {
    lines.push(<Line key="thread" kind="untied-thread" label="Thread" main={THREAD_UNTIED_LINE} onOpen={() => onThread(untiedThread)} />);
  }
  return lines.length ? <div className="ib-lp-lines">{lines}</div> : null;
}
