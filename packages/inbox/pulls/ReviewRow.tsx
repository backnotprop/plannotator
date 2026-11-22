/**
 * A Reviews row, compact (approval "inbox-reviews-compact-list", part 1, "Compact 2 · one line, groups kept"): one
 * line per review, about 30px. It keeps its mark (the PR's state, a laptop for a local review, layers for a stack), the
 * title (bold when unread), and at the end the High pill, a red mark when checks fail, the agent's mark, a stack's
 * count and the age in a fixed column. The open row grows a second line with what the old third line said: the
 * author's picture, the number, the repository, the agent and why the row is where it is (its tone's colour), and a
 * Medium, Low or "Couldn't rank" mark. A stack unfolds its layers under it. A phone keeps 44px rows.
 */
import type { InboxPullLink, InboxPullRiskAutoRun, InboxPullStack, InboxReviewRow } from '@plannotator/core/inbox-types';
import { formatCount } from '@plannotator/core/inbox-format';
import { isTextCut } from '@plannotator/ui/utils/textCut';
import { HostMark, Icon } from '../icons';
import { RefMarkIcon } from '../board/RefMark';
import { Tip } from '../components/Tip';
import { relativeWords } from '../relativeTime';
import { ChecksMark } from '../prs/ChecksMark';
import { pullNounWord, stackTitle } from './model';
import { initials } from './labels';
import { chainMarks } from './topology';
import { reviewRowLanding, reviewRowLine, reviewRowTitle } from './reviewsModel';
import { reviewAge, rowChecksFailing, titleTail } from './reviewRowParts';
import { riskLevelWord, rowRisk, rowRiskFailure, type RiskFailures, type RiskJudgments } from './risk';
import { COULD_NOT_RANK, RiskMark } from './RiskMark';
import { Named, usePicture } from './Face';
import { facesOnce } from './words';
import { pullAvatarUrl } from './pullUrls';

/**
 * The PR author's profile picture (the person's own PRs too; a stack's bottom layer's author), read through the
 * Inbox's own route (`GET /api/inbox/pulls/avatar`): the window's CSP never loads a remote image. The initials show
 * while it loads and stay when it cannot; a deleted account is a grey person. On the open row's second line.
 */
function AuthorLead({ stack }: { stack: InboxPullStack }) {
  const bottom = stack.layers[0]!;
  const author = bottom.author;
  const src = author ? pullAvatarUrl(bottom.host, author) : null;
  // The same picture state as every face (`Face.tsx`), so a picture that failed in one is never asked again here.
  const { shown, failed, state, onLoad, onError } = usePicture(src);
  if (!author || !src) {
    return (
      <Tip content="A deleted account">
        <span className="ib-pr-av ib-pr-av-ghost" role="img" aria-label="A deleted account" data-pulls-ghost="">
          <Icon name="user" size={11} />
        </span>
      </Tip>
    );
  }
  return (
    <Tip content={author}>
      <span className="ib-pr-av" role="img" aria-label={author} data-pulls-author={author} data-pulls-bot={author.endsWith('[bot]') ? '' : undefined} data-pulls-avatar={state}>
        {!shown && <span aria-hidden="true">{initials(author)}</span>}
        {!failed && (
          <img
            src={src}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            draggable={false}
            data-shown={shown ? '' : undefined}
            onLoad={onLoad}
            onError={onError}
          />
        )}
      </span>
    </Tip>
  );
}

/** The chain of PR marks, bottom (lands first) to top: past five layers, the first two, "+N" and the last two. */
function Chain({ stack }: { stack: InboxPullStack }) {
  return (
    <span className="ib-pr-chain" aria-hidden="true" data-pulls-chain={stack.layers.length}>
      {chainMarks(stack.layers).map((mark, i) => (
        <span key={'more' in mark ? 'more' : mark.key} className="ib-pr-link">
          {i > 0 && <span className="ib-pr-dash" />}
          {'more' in mark ? (
            <span className="ib-pr-more" data-pulls-chain-more={mark.more}>
              +{mark.more}
            </span>
          ) : (
            <span className="ib-bc-mark" data-card-mark={mark.state} data-card-mark-kind="pr">
              <RefMarkIcon kind="pr" state={mark.state} size={13} />
            </span>
          )}
        </span>
      ))}
    </span>
  );
}

/** A title on one line: cut at its end, or, a long unbroken run, in its middle so the end that tells rows apart stays. */
export function Title({ text }: { text: string }) {
  const split = titleTail(text);
  if (!split) {
    return (
      <span className="ib-rvr-t" dir="auto">
        {text}
      </span>
    );
  }
  return (
    <span className="ib-rvr-t" dir="ltr" data-reviews-title-split="">
      <span className="ib-rvr-th" aria-hidden="true">
        {split.head}
      </span>
      <span className="ib-rvr-tt" aria-hidden="true">
        {split.tail}
      </span>
      <span className="ib-sr">{text}</span>
    </span>
  );
}

/** The age, in its fixed column; a screen reader hears it in words. */
export function Age({ iso, now }: { iso: string; now: number }) {
  return (
    <span className="ib-t ib-rvr-age">
      <span aria-hidden="true">{reviewAge(iso, now)}</span>
      <span className="ib-sr">{relativeWords(iso, now)}</span>
    </span>
  );
}

/** The row's full title as its tooltip, only while the line cuts it: read on the pointer's arrival, never per frame. */
function titleWhenCut(event: React.PointerEvent<HTMLElement>, title: string) {
  const row = event.currentTarget;
  const cut = isTextCut(row.querySelector('.ib-rvr-t'), '.ib-rvr-th');
  if (cut) row.title = title;
  else row.removeAttribute('title');
}

export interface ReviewRowProps {
  row: InboxReviewRow;
  links: Readonly<Record<string, InboxPullLink>>;
  place: string;
  selected: boolean;
  phone: boolean;
  now: number;
  judgments: RiskJudgments;
  riskFailed: RiskFailures;
  autoRuns?: Readonly<Record<string, InboxPullRiskAutoRun>>;
  /** Its right-click menu is open (the muted background the Inbox's rows take then). */
  menu?: boolean;
  onOpen: () => void;
}

/** One review: the line, and on the open row the second line. A stack's count is drawn by `ReviewStack` over it. */
export function ReviewRowItem({ row, links, place, selected, phone, now, judgments, riskFailed, autoRuns, menu = false, onOpen, count }: ReviewRowProps & { count?: number }) {
  const stack = row.stacks[0] ?? null;
  // A thread's row is judged by the PRs it owns, a reported branch by its report; a local review has neither, so no mark.
  const judged = rowRisk(row, judgments);
  const riskFailure = rowRiskFailure(row, judgments, riskFailed);
  const line = reviewRowLine(row, autoRuns);
  const layers = stack?.layers.length ?? 0;
  const focusPull = stack?.layers.find((pull) => pull.state === 'open' || pull.state === 'draft') ?? stack?.layers[0] ?? null;
  const title = reviewRowTitle(row, (s) => stackTitle(s, links));
  const high = judged?.level === 'high';
  // What the open row's second line says of the risk; High stays on the line itself.
  const quietRisk = judged && !high ? judged : null;
  const level = judged?.level ?? (riskFailure ? 'failed' : undefined);
  const prState = focusPull?.state ?? reviewRowLanding(row)?.state ?? 'open';
  const failing = rowChecksFailing(row);
  return (
    <button
      type="button"
      className={`${phone ? 'ib-mrow' : 'ib-nrow'} ib-prrow${row.move === 'on_you' && row.reviewed ? ' ib-u' : ''}${selected ? ' ib-sel' : ''}`}
      onClick={onOpen}
      onPointerEnter={(event) => titleWhenCut(event, title)}
      aria-current={selected ? 'true' : undefined}
      data-reviews-row={row.id}
      data-reviews-kind={row.reviewed ? 'reviewed' : 'listed'}
      // The thread's row, for the window's J and K and its way back; a listed PR is no thread.
      data-row={row.reviewed ? (row.thread_id ?? undefined) : undefined}
      data-thread-id={row.reviewed ? (row.thread_id ?? undefined) : undefined}
      data-pulls-row={stack?.id}
      data-pulls-move={row.move}
      data-pulls-layers={stack ? layers : undefined}
      data-pulls-risk={level}
      data-menu={menu ? '' : undefined}
    >
      <span className="ib-rvr-l1">
        <span className="ib-rvr-mark" aria-hidden="true">
          {line.kind === 'stack' ? (
            <Icon name="layers" size={15} />
          ) : line.kind === 'pr' ? (
            <span className="ib-bc-mark" data-card-mark={prState} data-card-mark-kind="pr">
              <RefMarkIcon kind="pr" state={prState} size={14} />
            </span>
          ) : (
            <Icon name={line.mark ?? 'laptop'} size={15} />
          )}
        </span>
        <Title text={title} />
        <span className="ib-rvr-end">
          {high && <RiskMark judgment={judged} />}
          {!selected && level && !high && <span className="ib-sr">, {quietRisk ? `${riskLevelWord[quietRisk.level]} risk` : COULD_NOT_RANK}</span>}
          {failing && (
            <Tip content="Checks failing">
              <span className="ib-rvr-ck" data-reviews-checks="failure">
                <ChecksMark checks="failure" />
                <span className="ib-sr">, checks failing</span>
              </span>
            </Tip>
          )}
          {line.agent && (
            <span className="ib-pr-magent ib-rvr-agent" data-reviews-agent={line.agent.host ?? ''} title={line.agent.name}>
              <HostMark host={line.agent.host} />
              <span className="ib-sr">{line.agent.name}</span>
            </span>
          )}
          {/* Room for the stack's count, which `ReviewStack` draws as its own button on top. */}
          {count !== undefined && (
            <span className="ib-rvr-cnt ib-rvr-cnt-room" aria-hidden="true">
              {formatCount(count)}
              <Icon name="chevD" size={12} />
            </span>
          )}
          <Age iso={row.updated_at} now={now} />
        </span>
      </span>
      {selected ? (
        <span className="ib-rvr-l2" data-reviews-line2="">
          {stack && (
            <span className="ib-lead">
              <AuthorLead stack={stack} />
            </span>
          )}
          <span className="ib-pr-l3">
            {line.kind === 'stack' && stack && <Chain stack={stack} />}
            <span className="ib-pv" dir="auto">
              {layers > 1 && stack && (
                <span className="ib-sr">
                  A stack of {layers} {pullNounWord(stack.platform)}s:{' '}
                </span>
              )}
              {line.lead && `${line.lead} · `}
              <span data-pulls-repo="">{place}</span>
              {(line.agent || line.status) && ' · '}
              {line.agent && (
                <span className="ib-pr-magent" data-pulls-row-agent={line.agent.host ?? ''} title={line.agent.name} aria-label={line.agent.name}>
                  <HostMark host={line.agent.host} />
                </span>
              )}
              {line.status && (
                <span className="ib-pr-mstatus" data-tone={line.tone ?? undefined} data-reviews-status="">
                  {/* A face by each name, but not twice: the author pictured at the line's start keeps only their name. */}
                  <Named words={facesOnce(line.parts, stack ? [stack.layers[0]!.author] : [])} host={stack?.layers[0]!.host ?? null} />
                </span>
              )}
            </span>
          </span>
          {quietRisk && <RiskMark judgment={quietRisk} />}
          {riskFailure && <RiskMark failed={riskFailure} />}
        </span>
      ) : (
        // Not open: the second line's words for a screen reader only, so nothing is lost to it.
        <span className="ib-sr">
          {line.lead && `, ${line.lead}`}, <span data-pulls-repo="">{place}</span>
          {[line.agent?.name, line.status].filter(Boolean).map((words) => `, ${words}`)}
        </span>
      )}
    </button>
  );
}

/**
 * A stack: its row, its count as a button over the row's end (a sibling, never a button in a button), and its layers
 * under it while unfolded, indented. A layer's row opens the stack, as the stack's row does.
 */
export function ReviewStack(props: ReviewRowProps & { open: boolean; onToggle: () => void }) {
  const { row, open, onToggle, phone, now, onOpen } = props;
  const stack = row.stacks[0]!;
  const n = stack.layers.length;
  const noun = pullNounWord(stack.platform);
  return (
    <div className="ib-rvr-stk" data-reviews-stack={row.id} data-open={open ? '' : undefined}>
      <ReviewRowItem {...props} count={n} />
      <button
        type="button"
        className="ib-rvr-cnt ib-rvr-stkbtn"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={`${open ? 'Hide' : 'Show'} the stack's ${formatCount(n)} ${noun}s`}
        data-reviews-stack-toggle={row.id}
      >
        {formatCount(n)}
        <Icon name={open ? 'chevD' : 'chevR'} size={12} />
      </button>
      {open && (
        <div className="ib-rvr-layers" role="group" aria-label={`The stack's ${noun}s`}>
          {/* From the base up, as the chain and the stack's page order them: the first to land first. */}
          {stack.layers.map((layer) => (
            <button key={layer.key} type="button" tabIndex={-1} className={`${phone ? 'ib-mrow' : 'ib-nrow'} ib-prrow ib-rvr-child`} onClick={onOpen} data-reviews-layer={layer.key}>
              <span className="ib-rvr-l1">
                <span className="ib-rvr-mark" aria-hidden="true">
                  <span className="ib-bc-mark" data-card-mark={layer.state} data-card-mark-kind="pr">
                    <RefMarkIcon kind="pr" state={layer.state} size={14} />
                  </span>
                </span>
                <Title text={layer.title} />
                <span className="ib-rvr-end">
                  {layer.state !== 'merged' && layer.state !== 'closed' && layer.checks === 'failure' && (
                    <span className="ib-rvr-ck" data-reviews-checks="failure">
                      <ChecksMark checks="failure" />
                      <span className="ib-sr">, checks failing</span>
                    </span>
                  )}
                  <Age iso={layer.updated_at} now={now} />
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
