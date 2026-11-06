/**
 * One PR's launchpad (approval "pr-launchpad"): what clicking a single open PR in Reviews opens. The bar (the PR's
 * mark, number and repository; Open on GitHub, Close), the title and one line of facts (author, branch into base,
 * size, checks), then the ways into it: Guided review (wide, the primary), The diff, Review thread, Shape board (while
 * Shape is on) and System (coming, from Workspaces, no button). Then the PR's Details (`PullDetails`, laid in the page),
 * and Reply to the agent at the foot. A stack of several PRs keeps the stack page (`PullsPage` `StackView`), which owns
 * the hand-off (the picker, one thread at a time) and passes it in. No keyboard shortcuts of its own.
 */
import { useId, useRef, type ReactNode, type Ref, type RefObject } from 'react';
import type { InboxPull, InboxPullLink, InboxPullStack } from '@plannotator/core/inbox-types';
import { formatCount, plural } from '@plannotator/core/inbox-format';
import type { InboxShapeSummary } from '../api';
import { HostMark, Icon } from '../icons';
import { RefMarkIcon } from '../board/RefMark';
import { Tip } from '../components/Tip';
import { SidebarTrigger } from '../shell/sidebar';
import { relativeWords } from '../relativeTime';
import { Pebble } from '@plannotator/ui/components/shape/Pebble';
import { PullDetails, usePullDetails } from './PullDetails';
import { checksWords, inboxPullLabel, linkAgentName } from './model';
import { forgeName } from './labels';

/** The Start button and its picker, as the stack page's hand-off gives them. Null: no thread can start now. */
export interface LaunchpadStart {
  id: string;
  pickerId: string;
  ref: Ref<HTMLButtonElement>;
  /** A thread is starting, or its link is awaited: one at a time. */
  waits: boolean;
  picking: boolean;
  /** `again`: the last review thread's agent ended. */
  kind: 'review' | 'again';
  onToggle: () => void;
}

function Door({ kind, icon, title, sub, soon, wide, box, thread, children }: { kind: string; icon: ReactNode; title: string; sub: ReactNode; soon?: boolean; wide?: boolean; box?: Ref<HTMLDivElement>; thread?: string; children?: ReactNode }) {
  return (
    <div ref={box} tabIndex={box ? -1 : undefined} className="ib-lp-door" role="listitem" data-soon={soon ? '' : undefined} data-wide={wide ? '' : undefined} data-launch-door={kind} data-pulls-thread={thread}>
      <div className="ib-lp-door-h">
        <span className="ib-lp-ic" aria-hidden="true">
          {icon}
        </span>
        <b>{title}</b>
        {soon && <span className="ib-lp-soon">Coming</span>}
      </div>
      <div className="ib-lp-sub">{sub}</div>
      {children}
    </div>
  );
}

export function PullLaunchpad({
  stack,
  pr,
  link,
  phone,
  now,
  heading,
  said,
  start,
  picker,
  shapes,
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
  phone: boolean;
  now: number;
  /** The title: it takes focus when the page opens on a phone. */
  heading: RefObject<HTMLHeadingElement | null>;
  /** Where focus goes once a review thread has started: the door that names its agent. */
  said: RefObject<HTMLDivElement | null>;
  start: LaunchpadStart | null;
  picker: ReactNode;
  /** Shape boards by thread; null while Shape is off (no Shape board door then). */
  shapes: ReadonlyMap<string, InboxShapeSummary> | null;
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
  const agent = linkAgentName(link) ?? 'the agent';
  const ended = link?.agent?.ended === true;
  const guide = link?.guide ?? null;
  // The person asked for it (the hand-off) and it has not arrived yet.
  const onItsWay = !!link && !ended && !guide && link.via === 'owner' && !!link.ask;
  const shape = shapes && link ? (shapes.get(link.thread_id) ?? null) : null;
  const repo = stack.host === 'github.com' ? stack.repo : `${stack.host}/${stack.repo}`;
  const checks = checksWords(pr);
  const agentMark = <HostMark host={link?.agent?.host ?? null} />;
  return (
    <section className="ib-pane ib-prpane ib-lp" aria-labelledby={titleId} data-pulls-stack={stack.id} data-launchpad="">
      <div className="ib-pr-bar ib-lp-bar">
        {phone ? (
          <button type="button" className="ib-iconbtn" onClick={onClose} aria-label="Back to reviews">
            <Icon name="back" />
          </button>
        ) : (
          <SidebarTrigger />
        )}
        <span className="ib-lp-mark ib-bc-mark" data-card-mark={pr.state} data-card-mark-kind="pr" aria-hidden="true">
          <RefMarkIcon kind="pr" state={pr.state} size={15} />
        </span>
        <span className="ib-lp-num">{inboxPullLabel(pr)}</span>
        <Tip cut content={repo}>
          <span className="ib-lp-repo" dir="auto">
            {repo}
          </span>
        </Tip>
        <span className="ib-sp" />
        <a className="ib-pr-ext" href={pr.url} target="_blank" rel="noreferrer noopener" data-pulls-open-forge="">
          <Icon name="external" size={15} />
          {phone ? <span className="ib-sr">Open on {forge}</span> : `Open on ${forge}`}
        </a>
        {!phone && (
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

          <div className="ib-lp-grid" role="list" aria-label={`What to do with ${inboxPullLabel(pr)}`} data-doors={shapes ? 5 : 4}>
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
                    </Tip>{' '}
                    · {plural(guide.steps, 'chapter')} by {agentMark} {agent}
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
              {guide && link ? (
                <div className="ib-lp-go">
                  <button type="button" className="ib-btn ib-pri" onClick={() => onGuide(link.thread_id, guide.message_id)} data-launch-go="guide">
                    <Icon name="map" size={15} />
                    Open the guided review
                  </button>
                </div>
              ) : start ? (
                <div className="ib-lp-go">
                  <button
                    ref={start.ref}
                    id={start.id}
                    type="button"
                    className="ib-btn ib-pri"
                    disabled={start.waits}
                    onClick={start.onToggle}
                    aria-expanded={start.picking}
                    aria-controls={start.picking ? start.pickerId : undefined}
                    data-pulls-primary={start.kind}
                    data-launch-go="start"
                  >
                    <Icon name="plus" size={15} />
                    Start a guided review
                  </button>
                </div>
              ) : null}
              {picker}
            </Door>
            <Door kind="diff" icon={<Icon name="code" size={18} />} title="The diff" sub={<>All {plural(pr.files, 'file')} with your comments, Viewed and Approve.</>}>
              <div className="ib-lp-go">
                <button type="button" className="ib-btn" onClick={onDiff} data-launch-go="diff" data-pulls-open-diff="">
                  Open the diff
                </button>
              </div>
            </Door>
            <Door
              kind="thread"
              box={said}
              thread={link?.thread_id}
              icon={<Icon name="questionBubble" size={18} />}
              title="Review thread"
              sub={
                link ? (
                  <>
                    {ended ? (
                      <>
                        {agentMark} {agent} ended
                      </>
                    ) : (
                      <>With {agentMark} {agent}</>
                    )}
                    {link.last ? (
                      <>
                        {' '}
                        · <span dir="auto">“{link.last.preview}”</span>
                      </>
                    ) : (
                      !ended && <> · No answer yet</>
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
                      </Tip>{' '}
                      · v{shape.latest} · {relativeWords(shape.updated, now)}
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
            <Door kind="system" soon icon={<Icon name="cube" size={18} />} title="System" sub={<>Where this change sits among the services, data and owners around it. From Workspaces.</>} />
          </div>

          <h3 className="ib-lp-h">Details</h3>
          <div className="ib-lp-details">
            <PullDetails
              layer={pr}
              description={null}
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
            />
          </div>
        </div>
      </div>
      {foot}
    </section>
  );
}
