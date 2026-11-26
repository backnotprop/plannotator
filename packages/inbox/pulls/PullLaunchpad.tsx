import { useId, useRef, type ReactNode, type RefObject } from 'react';
import { usePhoneHeadFit } from '../headFit';
import { useInboxTextSize } from '../textSize';
import type { InboxPull, InboxPullLink, InboxPullStack } from '@plannotator/core/inbox-types';
import { formatCount, plural } from '@plannotator/core/inbox-format';
import { Icon } from '../icons';
import { RefMarkIcon } from '../board/RefMark';
import { Tip } from '../components/Tip';
import { PullDetails, usePullDetails } from './PullDetails';
import { checksWords, inboxPullLabel } from './model';
import { forgeName } from './labels';
import { LaunchpadLines, type LaunchPicturePage } from './LaunchpadLines';
import { LaunchpadLiveAsks, type LaunchAsks } from './LaunchpadLiveAsks';
import { latestPictureItPage } from './usePictureItAsk';
import { useLaunchpadThread } from './useLaunchpadThread';
import { shutWord } from './stateWord';

export interface LaunchpadStart {
  onStart: (opener: HTMLElement) => void;
  onPictureIt: (opener: HTMLElement) => void;
}

export const START_THREAD = 'Start a thread';

/**
 * The way back to the Reviews list where the PR's pane covers it: on a phone, and in a window too narrow for the list
 * and the pane side by side (stack.ts, `stacked`). The same control a covering thread leads with (`‹ Inbox`,
 * components/Thread.tsx), so a PR and a thread close the same way. Null beside the list, where Close (×) is the way.
 */
/** The least room the bar's number and repository keep on a phone before `‹ Reviews` shows its chevron alone. */
const SUBJECT_FLOOR_PX = 170;

export function PullPaneBack({ phone, stacked, onClose }: { phone: boolean; stacked: boolean; onClose: () => void }) {
  if (phone) {
    // Short of room the bar shows the chevron alone (`usePhoneHeadFit`, as a thread's `‹ Inbox`): the name stays.
    return (
      <Tip content="Back to Reviews">
        <button type="button" className="ib-pback" onClick={onClose} aria-label="Back to Reviews" data-phone-back="">
          <Icon name="chevL" size={18} />
          <span className="ib-pback-l">Reviews</span>
        </button>
      </Tip>
    );
  }
  if (!stacked) return null;
  return (
    <>
      <Tip content="Back to Reviews">
        <button type="button" className="ib-pback" onClick={onClose} aria-label="Back to Reviews" data-stack-back="">
          <Icon name="chevL" size={16} />
          <span className="ib-pback-l">Reviews</span>
        </button>
      </Tip>
      <span className="ib-vsep" aria-hidden="true" />
    </>
  );
}

/**
 * The PR's bar: the way back (a phone, a covering pane), the PR's mark, number and repository, Open on GitHub, Close.
 * The launchpad's, and an empty thread's for the PR (Start a thread, `PullThreadStart`). A phone's bar gives way as a
 * thread's header does (headFit.ts): `‹ Reviews` shows its chevron alone before the PR's number and repository (its
 * subject) lose their room.
 */
export function PullBar({ stack, pr, phone, stacked, onClose, onHide }: { stack: InboxPullStack; pr: InboxPull; phone: boolean; stacked: boolean; onClose: () => void; onHide?: () => void }) {
  const forge = forgeName(stack);
  const repo = stack.host === 'github.com' ? stack.repo : `${stack.host}/${stack.repo}`;
  const bar = useRef<HTMLDivElement>(null);
  usePhoneHeadFit(bar, phone, [stacked, inboxPullLabel(pr), repo, useInboxTextSize()].join('|'));
  return (
    <div ref={bar} className="ib-pr-bar ib-lp-bar">
      <PullPaneBack phone={phone} stacked={stacked} onClose={onClose} />
      <span className="ib-lp-id" data-fit-subject={SUBJECT_FLOOR_PX}>
        <span className="ib-lp-mark ib-bc-mark" data-card-mark={pr.state} data-card-mark-kind="pr" aria-hidden="true">
          <RefMarkIcon kind="pr" state={pr.state} size={15} />
        </span>
        <span className="ib-lp-num">{inboxPullLabel(pr)}</span>
        <Tip cut content={repo}>
          <span className="ib-lp-repo" dir="auto">
            {repo}
          </span>
        </Tip>
      </span>
      <a className="ib-pr-ext" href={pr.url} target="_blank" rel="noreferrer noopener" data-pulls-open-forge="">
        <Icon name="external" size={15} />
        {phone ? <span className="ib-sr">Open on {forge}</span> : `Open on ${forge}`}
      </a>
      {onHide && (
        <Tip content={`Hide from your lists. It stays open on ${forge}.`}>
          <button type="button" className="ib-pr-ext" onClick={onHide} data-pulls-hide="">
            <Icon name="eyeOff" size={15} />
            {phone ? <span className="ib-sr">Hide</span> : 'Hide'}
          </button>
        </Tip>
      )}
      {!phone && !stacked && (
        <Tip content="Close">
          <button type="button" className="ib-iconbtn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </Tip>
      )}
    </div>
  );
}

export function PullLaunchpad({
  stack,
  pr,
  link: given,
  mentioned = false,
  phone,
  stacked = false,
  now,
  heading,
  start,
  startThread = null,
  untiedThread = null,
  risk = null,
  ship = null,
  onClose,
  onDiff,
  onThread,
  onGuide,
  onPicture,
  onAsked,
  onHide,
  foot,
}: {
  stack: InboxPullStack;
  pr: InboxPull;
  link: InboxPullLink | null;
  mentioned?: boolean;
  phone: boolean;
  stacked?: boolean;
  now: number;
  heading: RefObject<HTMLHeadingElement | null>;
  start: LaunchpadStart | null;
  startThread?: (() => void) | null;
  untiedThread?: string | null;
  risk?: ReactNode;
  /** The ship log while the PR ships (useShipping.tsx `PageShipLog`). */
  ship?: ReactNode;
  onClose: () => void;
  onDiff: () => void;
  onThread: (threadId: string) => void;
  onGuide: (threadId: string, messageId: string) => void;
  onPicture: (threadId: string, page: LaunchPicturePage) => void;
  onAsked: () => void;
  onHide?: () => void;
  foot: ReactNode;
}) {
  const forge = forgeName(stack);
  const titleId = useId();
  const panel = useRef<HTMLElement>(null);
  const details = usePullDetails(pr.key, `${pr.head_sha ?? ''}\u0000${pr.updated_at}`);
  const link = mentioned ? null : given;
  const named = mentioned ? given : null;
  const live = link && !link.agent?.ended ? link : null;
  const thread = useLaunchpadThread(link?.thread_id ?? null, [link?.last?.message_id, link?.ask, link?.guide?.message_id, link?.picture_it_asked_at, link?.picture_it_page?.message_id].join('|'));
  const read = thread && thread !== 'failed' ? thread : null;
  const checks = checksWords(pr);
  const inThread = read ? latestPictureItPage(read) : null;
  const known = link?.picture_it_page ?? null;
  const page: LaunchPicturePage | null = known
    ? { message_id: known.message_id, title: known.title, at: known.at, attachment_id: inThread?.message_id === known.message_id ? inThread.attachment_id : null }
    : inThread && read
      ? { ...inThread, at: read.messages.find((m) => m.id === inThread.message_id)?.created_at ?? '' }
      : null;
  const openThread = () => live && onThread(live.thread_id);
  const idle: LaunchAsks = start
    ? { guide: { onPress: start.onStart, onTheWay: false, error: null }, picture: { onPress: start.onPictureIt, onTheWay: false, error: null } }
    : { guide: { onPress: thread === 'failed' ? openThread : null, onTheWay: false, error: null }, picture: { onPress: thread === 'failed' ? openThread : null, onTheWay: false, error: null } };
  const draw = (asks: LaunchAsks) => (
    <>
      <div className="ib-pr-actions ib-lp-row" data-launch-row="">
        <button type="button" className="ib-btn ib-pri" onClick={onDiff} data-launch-go="diff" data-pulls-open-diff="">
          Open the diff
        </button>
        <button type="button" className="ib-btn" disabled={!asks.guide.onPress} onClick={(event) => asks.guide.onPress?.(event.currentTarget)} data-launch-go="guide">
          Guided review
        </button>
        <button type="button" className="ib-btn" disabled={!asks.picture.onPress} onClick={(event) => asks.picture.onPress?.(event.currentTarget)} data-launch-go="picture">
          Picture it
        </button>
        {startThread && !link && !named && (
          <button type="button" className="ib-btn" onClick={startThread} data-launch-go="start-thread">
            {START_THREAD}
          </button>
        )}
      </div>
      {(asks.guide.error || asks.picture.error) && (
        <div className="ib-error" role="alert" data-launch-error="">
          {asks.guide.error ?? asks.picture.error}
        </div>
      )}
      <LaunchpadLines
        link={link}
        named={named}
        untiedThread={link || named ? null : untiedThread}
        page={page}
        pictureOnTheWay={asks.picture.onTheWay}
        guideOnTheWay={asks.guide.onTheWay}
        now={now}
        onPicture={onPicture}
        onGuide={onGuide}
        onThread={onThread}
      />
    </>
  );
  return (
    <section className="ib-pane ib-prpane ib-lp" aria-labelledby={titleId} data-pulls-stack={stack.id} data-launchpad="">
      <PullBar stack={stack} pr={pr} phone={phone} stacked={stacked} onClose={onClose} onHide={onHide} />
      <div className="ib-pr-body ib-lp-body">
        <div className="ib-lp-wrap">
          <h2 id={titleId} ref={heading} tabIndex={-1} className="ib-pr-h" dir="auto">
            {pr.title}
          </h2>
          <div className="ib-pr-meta ib-lp-meta" data-launch-facts="">
            {pr.state === 'draft' && <span data-launch-draft="">Draft</span>}
            {shutWord(pr.state) && <span data-launch-state={pr.state}>{shutWord(pr.state)}</span>}
            {pr.author && <span dir="auto">by {pr.mine ? 'you' : pr.author}</span>}
            <span className="ib-lp-ref">
              <Tip cut content={pr.head}>
                <code className="ib-lp-head">{pr.head}</code>
              </Tip>
              <span aria-hidden="true">→</span>
              <span className="ib-sr">into</span>
              <Tip cut content={pr.base}>
                <code className="ib-lp-base">{pr.base}</code>
              </Tip>
            </span>
            <span className="ib-lp-size">
              <span className="ib-add">+{formatCount(pr.additions)}</span> <span className="ib-del">−{formatCount(pr.deletions)}</span>
            </span>
            <span>{plural(pr.files, 'file')}</span>
            {checks && (
              <span className="ib-lp-checks" data-checks={pr.checks}>
                {checks}
              </span>
            )}
          </div>
          {risk}
          {ship}
          {live && read ? (
            <LaunchpadLiveAsks thread={read} stack={stack} pr={pr} link={live} onDiff={onDiff} onAsked={onAsked} onThread={onThread}>
              {draw}
            </LaunchpadLiveAsks>
          ) : (
            draw(idle)
          )}

          <h3 className="ib-lp-h">Details</h3>
          <div className="ib-lp-details">
            <PullDetails
              layer={pr}
              description={details.data?.description}
              headSha={pr.head_sha}
              data={details.data}
              failed={details.failed}
              heldUntil={details.heldUntil}
              onRetry={details.retry}
              forge={forge}
              panel={panel}
              phone={phone}
              inDiff={() => false}
              onClose={() => {}}
              onFile={() => {}}
              headless
              descriptionUnread={details.failed && !details.data}
            />
          </div>
        </div>
      </div>
      {foot}
    </section>
  );
}
