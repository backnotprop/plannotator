/**
 * A Reviews row, compact (approval "inbox-reviews-compact-list", part 1, "Compact 2 · one line, groups kept"): one
 * line per review, about 30px. It keeps its mark (the PR's state, a laptop for a local review, layers for a stack), the
 * title (bold when unread), and at the end the High pill, a red mark when checks fail, the agent's mark, a stack's
 * count and the age in a fixed column. The open row grows a second line with what the old third line said: the
 * author's picture, the number, the repository, the agent and why the row is where it is (its tone's colour), and a
 * Medium, Low or "Couldn't rank" mark. A stack unfolds its layers under it, each a row of its own that opens that
 * layer. On a phone, where opening a row covers the list, every row has two lines, about 56px: the title's, and under
 * it the status words in their colours, Medium or Low, the repository and number (`PhoneLine`).
 *
 * A screen reader hears a closed row once, in this order: its mark's state, the title, the risk, failing checks, the
 * agent, the status words, the number and repository, the age.
 */
import type { InboxPull, InboxPullLink, InboxPullRiskAutoRun, InboxPullRiskJudgment, InboxPullStack, InboxReviewRow } from '@plannotator/core/inbox-types';
import { formatCount } from '@plannotator/core/inbox-format';
import { inboxPullLabel } from '@plannotator/core/inbox-types';
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
import { titleIsCut } from './titleCut';
import { riskLevelWord, rowRisk, rowRiskFailure, type RiskFailures, type RiskJudgments } from './risk';
import { COULD_NOT_RANK, RiskMark } from './RiskMark';
import { Named, usePicture } from './Face';
import { facesOnce } from './words';
import { pullAvatarUrl } from './pullUrls';
import { shipLook, type InboxShipView } from '@plannotator/core/inbox-pull-handoff';
import { ShipMark, ShipWater, ShipWords } from './ShipRow';
import { PULL_STATE_WORD } from './stateWord';

/**
 * The PR author's profile picture (the person's own PRs too; a stack's bottom layer's author), read through the
 * Inbox's own route (`GET /api/inbox/pulls/avatar`): the window's CSP never loads a remote image. The initials show
 * while it loads and stay when it cannot; a deleted account is a grey person. On the open row's second line.
 */
function AuthorLead({ pull }: { pull: InboxPull }) {
  const author = pull.author;
  const src = author ? pullAvatarUrl(pull.host, author) : null;
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

/**
 * A title on one line: cut at its end, or, a long unbroken run, in its middle so the end that tells rows apart stays.
 * A split title's pieces sit in one line (`.ib-rvr-tin`) that, too narrow for the kept end, cuts plainly at its end.
 */
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
      <span className="ib-rvr-tin" aria-hidden="true">
        <span className="ib-rvr-th">{split.head}</span>
        <span className="ib-rvr-tt">{split.tail}</span>
      </span>
      <span className="ib-sr">{text}</span>
    </span>
  );
}

/** The age, in its fixed column; a screen reader hears it in words (on a phone, at the end of the second line). */
export function Age({ iso, now, spoken = true }: { iso: string; now: number; spoken?: boolean }) {
  return (
    <span className="ib-t ib-rvr-age">
      <span aria-hidden="true">{reviewAge(iso, now)}</span>
      {spoken && <span className="ib-sr">{relativeWords(iso, now)}</span>}
    </span>
  );
}

/** "web-app #880", "billing-svc · 3 open, 1 merged": the repository, then the number or what the row is. */
const placeAndLead = (place: string, lead: string | null | undefined) => (lead ? `${place}${/^[#!]/.test(lead) ? ' ' : ' · '}${lead}` : place);

/**
 * A phone row's second line, every row's (opening a row there covers the list, so no row waits for it): what the
 * caller puts first, then Medium, Low or Couldn't rank, then the repository and number, on one line cut with "…",
 * and the age's words for a screen reader, last.
 */
function PhoneLine({ lead, quietRisk, riskFailure, where, age }: { lead: React.ReactNode; quietRisk: InboxPullRiskJudgment | null; riskFailure: string | null; where: string; age: string }) {
  const parts = [lead, quietRisk && <RiskMark key="risk" judgment={quietRisk} />, riskFailure && <RiskMark key="failed" failed={riskFailure} />, where].filter(Boolean);
  return (
    <span className="ib-rvr-l2p" data-reviews-line2-phone="">
      <span className="ib-pv" dir="auto">
        {parts.map((part, i) => (
          <span key={i} className="ib-rvr-l2p-part">
            {i > 0 && <span aria-hidden="true"> · </span>}
            {i > 0 && <span className="ib-sr">, </span>}
            {part}
          </span>
        ))}
      </span>
      <span className="ib-sr">, {age}</span>
    </span>
  );
}

/**
 * The row's full title as its title's tooltip, only while the line cuts it: read on the pointer's arrival, never per
 * frame. On the title, not the row's button, whose own title a screen reader would say again after its name.
 */
function titleWhenCut(event: React.PointerEvent<HTMLElement>, title: string) {
  const shown = event.currentTarget.querySelector<HTMLElement>('.ib-rvr-t');
  if (!shown) return;
  if (titleIsCut(shown)) shown.title = title;
  else shown.removeAttribute('title');
}

const STATE_WORD = PULL_STATE_WORD;

/** What a PR's mark says by its colour and shape, in words: "Open pull request", "Merged merge request". */
function prStateWords(state: InboxPull['state'], platform: InboxPull['platform']): string {
  return `${STATE_WORD[state]} ${pullNounWord(platform)}`;
}

/** A screen reader's words, each after a comma, for what has none. */
const srList = (words: readonly (string | null | undefined | false)[]) => words.filter(Boolean).map((w) => `, ${w}`).join('');

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
  /** Its pull request ships (ShipRow.tsx): ship mode. A stack's layers are looked up in `ships`. */
  ship?: InboxShipView | null;
  ships?: ReadonlyMap<string, InboxShipView>;
  onOpen: () => void;
}

/** One review: the line, and on the open row the second line. A stack's count is drawn by `ReviewStack` over it. */
export function ReviewRowItem({ row, links, place, selected, phone, now, judgments, riskFailed, autoRuns, menu = false, ship = null, onOpen, count }: ReviewRowProps & { count?: number }) {
  const stack = row.stacks[0] ?? null;
  const look = shipLook(ship, now);
  // The row's words are of the PR whose ship it draws.
  const shown = look ? ship!.key : null;
  // A thread's row is judged by the PRs it owns, a reported branch by its report; a local review has neither, so no mark.
  const judged = rowRisk(row, judgments);
  const riskFailure = rowRiskFailure(row, judgments, riskFailed);
  const line = reviewRowLine(row, autoRuns, shown);
  const layers = stack?.layers.length ?? 0;
  const focusPull = stack?.layers.find((pull) => pull.state === 'open' || pull.state === 'draft') ?? stack?.layers[0] ?? null;
  const title = reviewRowTitle(row, (s) => stackTitle(s, links), shown);
  const high = judged?.level === 'high';
  // What the open row's second line says of the risk; High stays on the line itself.
  const quietRisk = judged && !high ? judged : null;
  const level = judged?.level ?? (riskFailure ? 'failed' : undefined);
  const landing = reviewRowLanding(row, shown);
  const prState = focusPull?.state ?? landing?.state ?? 'open';
  const platform = stack?.platform ?? landing?.platform ?? 'github';
  const failing = rowChecksFailing(row);
  // A phone: every row two lines (`PhoneLine`); a desktop: the open row's second line only.
  const twoLine = phone;
  const wide = selected && !twoLine;
  // The mark's state in words: a stack's count, on the desktop's open row, is its second line's.
  const markWords = line.kind === 'pr' ? prStateWords(prState, platform) : line.kind === 'stack' && !wide ? `A stack of ${layers} ${pullNounWord(platform)}s` : null;
  return (
    <button
      type="button"
      className={`${phone ? 'ib-mrow' : 'ib-nrow'} ib-prrow${row.move === 'on_you' && row.reviewed ? ' ib-u' : ''}${selected ? ' ib-sel' : ''}`}
      onClick={onOpen}
      onPointerEnter={(event) => titleWhenCut(event, title)}
      aria-current={selected ? 'true' : undefined}
      data-reviews-row={row.id}
      data-reviews-item={row.id}
      data-reviews-kind={row.reviewed ? 'reviewed' : 'listed'}
      // The thread's row, for the window's J and K and its way back; a listed PR is no thread.
      data-row={row.reviewed ? (row.thread_id ?? undefined) : undefined}
      data-thread-id={row.reviewed ? (row.thread_id ?? undefined) : undefined}
      data-pulls-row={stack?.id}
      data-pulls-move={row.move}
      data-pulls-layers={stack ? layers : undefined}
      data-pulls-risk={level}
      data-menu={menu ? '' : undefined}
      data-ship={look ?? undefined}
    >
      {ship && look && look !== 'merged' && <ShipWater ship={ship} />}
      <span className="ib-rvr-l1">
        <span className="ib-rvr-mark" aria-hidden="true">
          {look === 'shipping' || look === 'stuck' ? (
            <ShipMark />
          ) : line.kind === 'stack' ? (
            <Icon name="layers" size={15} />
          ) : line.kind === 'pr' ? (
            <span className="ib-bc-mark" data-card-mark={prState} data-card-mark-kind="pr">
              <RefMarkIcon kind="pr" state={prState} size={14} />
            </span>
          ) : (
            <Icon name={line.mark ?? 'laptop'} size={15} />
          )}
        </span>
        {markWords && <span className="ib-sr">{markWords}, </span>}
        <Title text={title} />
        {ship && look === 'stuck' && <ShipWords ship={ship} now={now} />}
        <span className="ib-rvr-end">
          {ship && look && look !== 'stuck' && <ShipWords ship={ship} now={now} />}
          {high && <RiskMark judgment={judged} />}
          {!selected && !twoLine && level && !high && <span className="ib-sr">, {quietRisk ? `${riskLevelWord[quietRisk.level]} risk` : COULD_NOT_RANK}</span>}
          {failing && (
            <Tip content="Checks failing">
              <span className="ib-rvr-ck" data-reviews-checks="failure">
                <ChecksMark checks="failure" />
                <span className="ib-sr">, checks failing</span>
              </span>
            </Tip>
          )}
          {line.agent && (
            // The desktop's open row's second line names the agent: once (this mark's tooltip would name it too).
            <span className="ib-pr-magent ib-rvr-agent" data-reviews-agent={line.agent.host ?? ''} title={line.agent.name} aria-hidden={wide ? 'true' : undefined}>
              <HostMark host={line.agent.host} />
              {!wide && <span className="ib-sr">, {line.agent.name}</span>}
            </span>
          )}
          {/* Room for the stack's count, which `ReviewStack` draws as its own button on top. */}
          {count !== undefined && (
            <span className="ib-rvr-cnt ib-rvr-cnt-room" aria-hidden="true">
              {formatCount(count)}
              <Icon name="chevD" size={12} />
            </span>
          )}
          {/* Not open, on a desktop: the second line's words, for a screen reader only, before the age. */}
          {!selected && !twoLine && (
            <span className="ib-sr">
              {srList([line.status])}
              {line.lead && `, ${line.lead}`}, <span data-pulls-repo="">{place}</span>,{' '}
            </span>
          )}
          <Age iso={row.updated_at} now={now} spoken={!twoLine} />
        </span>
      </span>
      {twoLine && (
        <PhoneLine
          lead={
            line.status ? (
              <span className="ib-pr-mstatus" data-tone={line.tone ?? undefined} data-reviews-status="">
                <Named words={facesOnce(line.parts, [])} host={stack?.layers[0]!.host ?? null} />
              </span>
            ) : null
          }
          quietRisk={quietRisk}
          riskFailure={riskFailure}
          where={placeAndLead(place, line.lead)}
          age={relativeWords(row.updated_at, now)}
        />
      )}
      {wide && (
        <span className="ib-rvr-l2" data-reviews-line2="">
          {stack && (
            <span className="ib-lead">
              <AuthorLead pull={stack.layers[0]!} />
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
                <span className="ib-pr-magent" data-pulls-row-agent={line.agent.host ?? ''} title={line.agent.name}>
                  <HostMark host={line.agent.host} />
                  {/* Its name as text, not a plain span's aria-label, which some screen readers skip. */}
                  <span className="ib-sr">
                    {line.agent.name}
                    {line.status && ', '}
                  </span>
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
      )}
    </button>
  );
}

/**
 * A layer's state for the eye on its second line, a phone's and a desktop's alike: "Draft", "Merged" or "Closed"
 * before its number, nothing for an open one. Its row says the state first to a screen reader already.
 */
const layerStateWord = (layer: InboxPull) => (layer.state === 'open' ? null : <span aria-hidden="true">{STATE_WORD[layer.state]}</span>);

/**
 * One layer of an unfolded stack: its own row, indented under the stack's with a tree line. It opens that layer, is
 * reached by Tab after the stack's count, shows its own risk and failing checks, and opens like any row: selected, its
 * second line (the author, the number and repository, Medium or Low).
 */
function LayerRow({ layer, place, selected, phone, now, judgments, riskFailed, menu, ship, onOpen }: { layer: InboxPull; place: string; selected: boolean; phone: boolean; now: number; judgments: RiskJudgments; riskFailed: RiskFailures; menu: boolean; ship: InboxShipView | null; onOpen: () => void }) {
  const look = shipLook(ship, now);
  const live = layer.state === 'open' || layer.state === 'draft';
  const judged = live ? (judgments[layer.key] ?? null) : null;
  const riskFailure = live && !judged ? (riskFailed[layer.key] ?? null) : null;
  const high = judged?.level === 'high';
  const quietRisk = judged && !high ? judged : null;
  const failing = live && layer.checks === 'failure';
  const twoLine = phone;
  return (
    <button
      type="button"
      className={`${phone ? 'ib-mrow' : 'ib-nrow'} ib-prrow ib-rvr-child${selected ? ' ib-sel' : ''}`}
      onClick={onOpen}
      onPointerEnter={(event) => titleWhenCut(event, layer.title)}
      aria-current={selected ? 'true' : undefined}
      data-reviews-layer={layer.key}
      data-reviews-item={layerItem(layer.key)}
      data-pulls-risk={judged?.level ?? (riskFailure ? 'failed' : undefined)}
      data-menu={menu ? '' : undefined}
      data-ship={look ?? undefined}
    >
      {ship && look && look !== 'merged' && <ShipWater ship={ship} />}
      {/* The tree line from the stack down to this layer: an element of the row, so it is always drawn on it. */}
      <span className="ib-rvr-tree" aria-hidden="true" data-reviews-tree="" />
      <span className="ib-rvr-l1">
        <span className="ib-rvr-mark" aria-hidden="true">
          {look === 'shipping' || look === 'stuck' ? (
            <ShipMark />
          ) : (
            <span className="ib-bc-mark" data-card-mark={layer.state} data-card-mark-kind="pr">
              <RefMarkIcon kind="pr" state={layer.state} size={14} />
            </span>
          )}
        </span>
        <span className="ib-sr">{prStateWords(layer.state, layer.platform)}, </span>
        <Title text={layer.title} />
        {ship && look === 'stuck' && <ShipWords ship={ship} now={now} />}
        <span className="ib-rvr-end">
          {ship && look && look !== 'stuck' && <ShipWords ship={ship} now={now} />}
          {high && <RiskMark judgment={judged} />}
          {!selected && !twoLine && (quietRisk || riskFailure) && <span className="ib-sr">, {quietRisk ? `${riskLevelWord[quietRisk.level]} risk` : COULD_NOT_RANK}</span>}
          {failing && (
            <Tip content="Checks failing">
              <span className="ib-rvr-ck" data-reviews-checks="failure">
                <ChecksMark checks="failure" />
                <span className="ib-sr">, checks failing</span>
              </span>
            </Tip>
          )}
          {!selected && !twoLine && (
            <span className="ib-sr">
              , {inboxPullLabel(layer)}, <span data-pulls-repo="">{place}</span>,{' '}
            </span>
          )}
          <Age iso={layer.updated_at} now={now} spoken={!twoLine} />
        </span>
      </span>
      {/* A layer's state is said at its start: on its second line, for the eye only; its number alone, as on a desktop. */}
      {twoLine && <PhoneLine lead={layerStateWord(layer)} quietRisk={quietRisk} riskFailure={riskFailure} where={inboxPullLabel(layer)} age={relativeWords(layer.updated_at, now)} />}
      {selected && !twoLine && (
        <span className="ib-rvr-l2" data-reviews-line2="">
          <span className="ib-lead">
            <AuthorLead pull={layer} />
          </span>
          <span className="ib-pr-l3">
            {/* Its number alone: the stack's row above names the repository. */}
            <span className="ib-pv" dir="auto">
              {layerStateWord(layer)}
              {layer.state !== 'open' && <span aria-hidden="true"> · </span>}
              {inboxPullLabel(layer)}
            </span>
          </span>
          {quietRisk && <RiskMark judgment={quietRisk} />}
          {riskFailure && <RiskMark failed={riskFailure} />}
        </span>
      )}
    </button>
  );
}

/** The right-click menu's id for a layer's row (a row's is its own id): never a row's, though a stack's id is its top layer's key. */
export const layerItem = (key: string) => `layer:${key}`;

/**
 * A stack: its row, its count as a button over the row's end (a sibling, never a button in a button), and its layers
 * under it while unfolded, indented. Tab goes from the row to the count, then down the layers. A layer's row opens
 * that layer.
 */
export function ReviewStack(props: ReviewRowProps & { open: boolean; onToggle: () => void; openLayer: string | null; onOpenLayer: (layer: InboxPull) => void; menuItem: string | null }) {
  const { row, open, onToggle, phone, now, place, judgments, riskFailed, openLayer, onOpenLayer, menuItem, ships } = props;
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
            <LayerRow
              key={layer.key}
              layer={layer}
              place={place}
              selected={openLayer === layer.key}
              phone={phone}
              now={now}
              judgments={judgments}
              riskFailed={riskFailed}
              menu={menuItem === layerItem(layer.key)}
              ship={ships?.get(layer.key) ?? null}
              onOpen={() => onOpenLayer(layer)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
