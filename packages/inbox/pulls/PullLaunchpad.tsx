/**
 * One PR's launchpad (approval "pr-launchpad"): what clicking a single open PR in Reviews opens, reviewed or not
 * (`reviewRowLaunchpad`). The bar (the PR's mark, number and repository; Open on GitHub, Close), the title and one line
 * of facts (author, branch into base, size, checks), the risk line when the PR was ranked, then the ways into it:
 * Guided review (wide, the primary), The diff, Review thread, Shape board (only while Shape is on) and System (coming,
 * from Workspaces, no button; only while System shows). Shape and System are both off in 0.29, so the page has three
 * doors there. Then the PR's Details (`PullDetails`, laid in the page), and Reply to the agent at the foot. A stack of several PRs keeps the stack page (`PullsPage` `StackView`), which owns
 * the hand-off (the New review box filled in with the PR, one review thread at a time) and passes it in. No keyboard
 * shortcuts of its own.
 */
import { useId, useRef, type ReactNode, type RefObject } from 'react';
import { usePhoneHeadFit } from '../headFit';
import { useInboxTextSize } from '../textSize';
import type { InboxPull, InboxPullLink, InboxPullStack } from '@plannotator/core/inbox-types';
import { formatCount, plural } from '@plannotator/core/inbox-format';
import type { InboxShapeSummary } from '../api';
import { HostMark, Icon } from '../icons';
import { RefMarkIcon } from '../board/RefMark';
import { Tip } from '../components/Tip';
import { relativeWords } from '../relativeTime';
import { Pebble } from '@plannotator/ui/components/shape/Pebble';
import { PullDetails, usePullDetails } from './PullDetails';
import { checksWords, inboxPullLabel, linkAgentName } from './model';
import { forgeName } from './labels';

/**
 * The diff door's words, the approved sentence with the PR's file count: "All 70 files with your comments, Viewed and
 * Approve." One file reads "The one file …"; a count the forge did not give (0) reads "All files …".
 */
export function diffWords(files: number): string {
  const which = files > 1 ? `All ${formatCount(files)} files` : files === 1 ? 'The one file' : 'All files';
  return `${which} with your comments, Viewed and Approve.`;
}

/** The Start button, as the stack page's hand-off gives it. Null: no review thread can start now (one at a time). */
export interface LaunchpadStart {
  /** `again`: the last review thread's agent ended. */
  kind: 'review' | 'again';
  /** The New review box, filled in with this PR; focus comes back to `opener` when it closes. */
  onStart: (opener: HTMLElement) => void;
}

function Door({ kind, icon, title, sub, soon, wide, thread, children }: { kind: string; icon: ReactNode; title: string; sub: ReactNode; soon?: boolean; wide?: boolean; thread?: string; children?: ReactNode }) {
  return (
    <div className="ib-lp-door" role="listitem" data-soon={soon ? '' : undefined} data-wide={wide ? '' : undefined} data-launch-door={kind} data-pulls-thread={thread}>
      <div className="ib-lp-door-h">
        <span className="ib-lp-ic" aria-hidden="true">
          {icon}
        </span>
        <h3 className="ib-lp-door-t">{title}</h3>
        {soon && <span className="ib-lp-soon">Coming</span>}
      </div>
      <div className="ib-lp-sub">{sub}</div>
      {children}
    </div>
  );
}

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
  shapes,
  system = false,
  risk = null,
  onClose,
  onDiff,
  onThread,
  onGuide,
  onShape,
  foot,
}: {
  stack: InboxPullStack;
  pr: InboxPull;
  link: InboxPullLink | null;
  /** The thread only named the PR (the Reviews page's rule): no review thread yet; that thread is offered as it is. */
  mentioned?: boolean;
  phone: boolean;
  /** The pane covers the list (stack.ts): it leads with `‹ Reviews` and has no Close, as a covering thread. */
  stacked?: boolean;
  now: number;
  /** The title: it takes focus when the page opens on a phone. */
  heading: RefObject<HTMLHeadingElement | null>;
  start: LaunchpadStart | null;
  /** Shape boards by thread; null while Shape is off (no Shape board door then). */
  shapes: ReadonlyMap<string, InboxShapeSummary> | null;
  /** System shows (`systemShown`, the Reviews page's `system`): only then the System door. */
  system?: boolean;
  /** The risk line(s) the stack page shows under its title (`PullsPage`), or null. */
  risk?: ReactNode;
  onClose: () => void;
  onDiff: () => void;
  onThread: (threadId: string) => void;
  onGuide: (threadId: string, messageId: string) => void;
  onShape: (shape: InboxShapeSummary) => void;
  foot: ReactNode;
}) {
  const forge = forgeName(stack);
  const titleId = useId();
  const panel = useRef<HTMLElement>(null);
  const details = usePullDetails(pr.key, `${pr.head_sha ?? ''}\u0000${pr.updated_at}`);
  // A thread that only named the PR is no review thread: the doors read as before one, and its own door offers it.
  const link = mentioned ? null : given;
  const agent = linkAgentName(given) ?? 'the agent';
  const ended = link?.agent?.ended === true;
  // A guided review is there once the agent's arrives (the stack page's rule, `ThreadLine`).
  const guide = link?.guide?.review ? link.guide : null;
  // The person asked for it (the hand-off) and it has not arrived yet.
  const onItsWay = !!link && !ended && !guide && link.via === 'owner' && !!link.ask;
  const shape = shapes && link ? (shapes.get(link.thread_id) ?? null) : null;
  const repo = stack.host === 'github.com' ? stack.repo : `${stack.host}/${stack.repo}`;
  const checks = checksWords(pr);
  // The grid lays itself out by how many doors there are (inbox.css `data-doors`), so no slot is left empty.
  const doors = 3 + (shapes ? 1 : 0) + (system ? 1 : 0);
  const agentMark = <HostMark host={given?.agent?.host ?? null} />;
  // The thread door's thread: the review thread, or the one that only named the PR.
  const named = mentioned ? given : null;
  // A phone's bar gives way as a thread's header does (headFit.ts): `‹ Reviews` shows its chevron alone before the
  // PR's number and repository (its subject) lose their room.
  const bar = useRef<HTMLDivElement>(null);
  usePhoneHeadFit(bar, phone, [stacked, inboxPullLabel(pr), repo, useInboxTextSize()].join('|'));
  return (
    <section className="ib-pane ib-prpane ib-lp" aria-labelledby={titleId} data-pulls-stack={stack.id} data-launchpad="">
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
        {!phone && !stacked && (
          <Tip content="Close">
            <button type="button" className="ib-iconbtn" onClick={onClose} aria-label="Close">
              <Icon name="x" />
            </button>
          </Tip>
        )}
      </div>
      <div className="ib-pr-body ib-lp-body">
        <div className="ib-lp-wrap">
          <h2 id={titleId} ref={heading} tabIndex={-1} className="ib-pr-h" dir="auto">
            {pr.title}
          </h2>
          <div className="ib-pr-meta ib-lp-meta" data-launch-facts="">
            {pr.state === 'draft' && <span data-launch-draft="">Draft</span>}
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

          <div className="ib-lp-grid" role="list" aria-label={`What to do with ${inboxPullLabel(pr)}`} data-doors={doors}>
            <Door
              kind="guide"
              wide
              icon={<Icon name="map" size={18} />}
              title="Guided review"
              sub={
                guide ? (
                  <>
                    <Tip cut content={guide.title}>
                      <span className="ib-lp-strong ib-lp-name" dir="auto">
                        {guide.title}
                      </span>
                    </Tip>
                    {'\u00a0· '}
                    {plural(guide.steps, 'chapter')} by {agentMark} {agent}
                  </>
                ) : onItsWay ? (
                  <>
                    {link!.ask === 'custom' ? 'Custom curation' : 'A guided review'} is on its way from {agentMark} {agent}.
                  </>
                ) : link && !ended ? (
                  <>None yet. Ask {agent} for one in the review thread.</>
                ) : (
                  <>An agent walks you through the change, chapter by chapter, then you approve or send feedback.</>
                )
              }
            >
              {(guide && link) || start || (link && !ended) ? (
                <div className="ib-lp-go">
                  {guide && link && (
                    <button type="button" className="ib-btn ib-pri" onClick={() => onGuide(link.thread_id, guide.message_id)} data-launch-go="guide">
                      <Icon name="map" size={15} />
                      Open the guided review
                    </button>
                  )}
                  {start && (
                    <button
                      type="button"
                      className={guide ? 'ib-btn' : 'ib-btn ib-pri'}
                      onClick={(event) => start.onStart(event.currentTarget)}
                      data-pulls-primary={start.kind}
                      data-launch-go="start"
                    >
                      <Icon name="plus" size={15} />
                      {guide ? 'Start a new guided review' : 'Start a guided review'}
                    </button>
                  )}
                  {!guide && !start && link && (
                    // A live thread with no guide yet (asked for, or not): its thread is where one comes. Starts nothing.
                    <button type="button" className="ib-btn ib-pri" onClick={() => onThread(link.thread_id)} data-launch-go="guide-thread" data-pulls-primary="open">
                      <Icon name="questionBubble" size={15} />
                      Open review thread
                    </button>
                  )}
                </div>
              ) : null}
            </Door>
            <Door kind="diff" icon={<Icon name="code" size={18} />} title="The diff" sub={diffWords(pr.files)}>
              <div className="ib-lp-go">
                <button type="button" className="ib-btn" onClick={onDiff} data-launch-go="diff" data-pulls-open-diff="">
                  Open the diff
                </button>
              </div>
            </Door>
            <Door
              kind="thread"
              thread={(link ?? named)?.thread_id}
              icon={<Icon name="questionBubble" size={18} />}
              title="Review thread"
              sub={
                named ? (
                  <>
                    <>Thread with {agentMark} {agent}</>
                    {named.last ? (
                      <span className="ib-lp-said" dir="auto">
                        “{named.last.preview}”
                      </span>
                    ) : (
                      <>{'\u00a0· '}No answer yet</>
                    )}
                  </>
                ) : link ? (
                  <>
                    {ended ? (
                      <>
                        {agentMark} {agent} ended
                      </>
                    ) : (
                      <>With {agentMark} {agent}</>
                    )}
                    {link.last ? (
                      <span className="ib-lp-said" dir="auto">
                        “{link.last.preview}”
                      </span>
                    ) : (
                      !ended && <>{'\u00a0· '}No answer yet</>
                    )}
                  </>
                ) : (
                  <>None yet. Starting a guided review starts one.</>
                )
              }
            >
              {link && (
                <div className="ib-lp-go">
                  <button type="button" className="ib-btn" onClick={() => onThread(link.thread_id)} data-launch-go="thread">
                    Open review thread
                  </button>
                </div>
              )}
              {named && (
                <div className="ib-lp-go">
                  <button type="button" className="ib-btn" onClick={() => onThread(named.thread_id)} data-launch-go="thread" data-pulls-open-thread="">
                    Open thread
                  </button>
                </div>
              )}
            </Door>
            {shapes && (
              <Door
                kind="shape"
                icon={<Pebble alive={!!shape} size={18} />}
                title="Shape board"
                sub={
                  shape ? (
                    <>
                      <Tip cut content={shape.title}>
                        <span className="ib-lp-strong ib-lp-name" dir="auto">
                          {shape.title}
                        </span>
                      </Tip>
                      {'\u00a0· '}v{shape.latest}
                      {'\u00a0· '}
                      {relativeWords(shape.updated, now)}
                    </>
                  ) : (
                    <>None yet. An agent draws one in the review thread.</>
                  )
                }
              >
                {shape && (
                  <div className="ib-lp-go">
                    <button type="button" className="ib-btn" onClick={() => onShape(shape)} data-launch-go="shape">
                      Open the Shape board
                    </button>
                  </div>
                )}
              </Door>
            )}
            {system && <Door kind="system" soon icon={<Icon name="cube" size={18} />} title="System" sub={<>Where this change sits among the services, data and owners around it. From Workspaces.</>} />}
          </div>

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
