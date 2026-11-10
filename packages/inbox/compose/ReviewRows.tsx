import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { inboxPullLabel, inboxReviewLinkOf, type InboxReviewChanges, type InboxReviewLinkAnswer } from '@plannotator/core/inbox-types';
import { Icon } from '../icons';
import { RefMarkIcon } from '../board/RefMark';
import { plural } from '@plannotator/core/inbox-format';
import { reviewLinkWords, type ReviewBoxPull, type ReviewKind, type ReviewPullsRead, type ReviewSummary } from './reviewBox';


function Choices<T extends string>({ label, value, options, onChange, name }: { label: string; value: T; options: readonly (readonly [T, string])[]; onChange: (next: T) => void; name: string }) {
  const group = useId();
  return (
    <div className="ib-cp-choices" role="radiogroup" aria-label={label} data-review-choices={name}>
      {options.map(([id, words]) => (
        <label key={id} className="ib-cp-choice" data-on={id === value ? '' : undefined}>
          <input type="radio" name={group} checked={id === value} onChange={() => onChange(id)} data-review-choice={id} />
          {words}
        </label>
      ))}
    </div>
  );
}

/** No visible label: each control says what it asks. */
const Row = ({ children }: { children: ReactNode }) => <div className="ib-cp-to ib-cp-rvrow">{children}</div>;

function SummaryLine({ summary }: { summary: ReviewSummary }) {
  if (!summary) return null;
  if (!summary.git) return <span className="ib-cp-rvsize" data-review-size="">Not a git repository</span>;
  if (summary.files === 0) return <span className="ib-cp-rvsize" data-review-size="">No changes</span>;
  return (
    <span className="ib-cp-rvsize" data-review-size="">
      {plural(summary.files, 'file')} <b className="ib-add">+{summary.additions}</b> <b className="ib-del">-{summary.deletions}</b>
    </span>
  );
}

/** Text that means a link, whatever it turns out to be: the search reads it instead of filtering the list. */
const isLinkText = (text: string) => inboxReviewLinkOf(text) !== null || /^\s*https?:\/\//i.test(text);

/** What a pull request's link was read as. */
function LinkReadLine({ read, inReview }: { read: InboxReviewLinkAnswer; inReview: boolean }) {
  return (
    <p className={read.ok ? 'ib-cp-rvreadok' : undefined} role="status" data-review-link-read={read.ok ? 'ok' : read.reason}>
      {read.ok && <Icon name="check" size={13} />}
      {reviewLinkWords(read)}
      {inReview ? ' · Already in review' : ''}
    </p>
  );
}

const linkStateWord = (read: Extract<InboxReviewLinkAnswer, { ok: true }>) => (read.pull.state === 'merged' || read.pull.state === 'closed' ? read.pull.state : null);

/**
 * The picker over what Reviews lists: FolderMenu's look and keys. Not reviewed comes first; a PR in review opens its
 * thread. Its search also takes a pasted link, for a PR that isn't listed, or to go straight to one that is.
 */
function PullMenu({ pulls, read, link, linkRead, linkInReview, onLink, onUseLink, selected, phone, onPick, onClose }: { pulls: readonly ReviewBoxPull[]; read: ReviewPullsRead; link: string; linkRead: InboxReviewLinkAnswer | null; linkInReview: boolean; onLink: (text: string) => void; onUseLink: () => void; selected: string | null; phone: boolean; onPick: (pull: ReviewBoxPull) => void; onClose: () => void }) {
  const [query, setQuery] = useState(link);
  const asLink = isLinkText(query);
  const options = useMemo(() => {
    if (isLinkText(query)) return [];
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return pulls.filter((pull) => words.every((word) => `${pull.label} ${pull.title} ${pull.project ?? ''}`.toLowerCase().includes(word)));
  }, [pulls, query]);
  const [hl, setHl] = useState(0);
  const at = Math.min(hl, options.length - 1);
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const optionId = (i: number) => `ib-cp-p-${uid}-${i}`;
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => input.current?.focus({ preventScroll: true }), []);
  const onKey = (event: ReactKeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setHl((at + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % Math.max(options.length, 1));
    } else if (event.key === 'Enter' && asLink) {
      event.preventDefault();
      event.stopPropagation();
      // Before its read lands too: the row then says what it finds. A link that failed says so right here.
      if (!linkRead || linkRead.ok) onUseLink();
    } else if (event.key === 'Enter' && options[at]) {
      event.preventDefault();
      event.stopPropagation();
      onPick(options[at]!);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };
  const firstInReview = options.findIndex((pull) => pull.thread);
  return (
    <div className="ib-cp-picker ib-cp-rvpulls" data-review-pulls="" data-phone={phone ? '' : undefined} onKeyDown={onKey}>
      {phone && (
        <div className="ib-cp-pickhead">
          <button type="button" className="ib-cp-back" onClick={onClose}>
            <Icon name="chevL" size={16} />
            Back
          </button>
          <span>Pull request</span>
        </div>
      )}
      <div className="ib-cp-filter">
        <Icon name="search" size={14} />
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={`ib-cp-plist-${uid}`}
          aria-activedescendant={at >= 0 ? optionId(at) : undefined}
          aria-label="Find a pull request, or paste a link"
          placeholder="Find a pull request, or paste a link"
          autoComplete="off"
          spellCheck={false}
          value={query}
          data-review-link=""
          onChange={(event) => {
            setQuery(event.target.value);
            setHl(0);
            onLink(isLinkText(event.target.value) ? event.target.value : '');
          }}
        />
      </div>
      <div className="ib-cp-list" role="listbox" id={`ib-cp-plist-${uid}`} aria-label="Pull requests">
        {asLink && !linkRead && <div className="ib-cp-none" data-review-link-reading="">Reading the link…</div>}
        {asLink && linkRead && !linkRead.ok && <div className="ib-cp-none"><LinkReadLine read={linkRead} inReview={false} /></div>}
        {asLink && linkRead?.ok && (
          <>
            <div
              role="option"
              aria-selected
              className="ib-cp-opt ib-cp-rvopt ib-hl"
              data-review-link-option={linkRead.pull.key}
              onMouseDown={(event) => event.preventDefault()}
              onClick={onUseLink}
            >
              <RefMarkIcon kind="pr" state={linkStateWord(linkRead) ?? 'open'} size={14} />
              <span className="ib-cp-rvlabel">{inboxPullLabel(linkRead.pull)}</span>
              <span className="ib-cp-op" dir="auto">{linkRead.pull.title}</span>
              <span className="ib-cp-rvwhere">{linkInReview ? 'open it' : (linkStateWord(linkRead) ?? linkRead.pull.repo)}</span>
            </div>
            <div className="ib-cp-rvread"><LinkReadLine read={linkRead} inReview={linkInReview} /></div>
          </>
        )}
        {!asLink && options.length === 0 && (
          <div className="ib-cp-none" data-review-pulls-none={read}>
            {pulls.length > 0 ? 'No pull request matches.' : read === 'reading' ? 'Reading your pull requests…' : read === 'failed' ? "Couldn't read your pull requests." : 'No open pull requests.'}
          </div>
        )}
        {options.map((pull, i) => (
          <div key={pull.id}>
            {i === 0 && firstInReview !== 0 && <div className="ib-cp-cap">Not reviewed yet</div>}
            {i === firstInReview && <div className="ib-cp-cap">Already in review</div>}
            <div
              id={optionId(i)}
              role="option"
              aria-selected={i === at}
              className={`ib-cp-opt ib-cp-rvopt${i === at ? ' ib-hl' : ''}`}
              data-review-pull={pull.id}
              data-in-review={pull.thread ? '' : undefined}
              onPointerMove={() => i !== at && setHl(i)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(pull)}
            >
              <RefMarkIcon kind="pr" state="open" size={14} />
              <span className="ib-cp-rvlabel">{pull.label}</span>
              <span className="ib-cp-op" dir="auto">{pull.title}</span>
              <span className="ib-cp-rvwhere">{pull.thread ? `${pull.thread.agent ? `with ${pull.thread.agent} · ` : ''}open it` : pull.project}</span>
              <span className="ib-cp-check" aria-hidden="true">
                {pull.id === selected && <Icon name="check" size={15} />}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** New review's rows above To: what is reviewed. */
export function ReviewRows(props: {
  kind: ReviewKind;
  onKind: (kind: ReviewKind) => void;
  changes: InboxReviewChanges;
  onChanges: (changes: InboxReviewChanges) => void;
  summary: ReviewSummary;
  pulls: readonly ReviewBoxPull[];
  pullsRead: ReviewPullsRead;
  pick: ReviewBoxPull | null;
  onPick: (pull: ReviewBoxPull) => void;
  phone: boolean;
  menu: boolean;
  onMenu: (open: boolean) => void;
  link: string;
  /** The search holds a link, or stopped holding one (''). */
  onLink: (text: string) => void;
  linkRead: InboxReviewLinkAnswer | null;
  /** The link's PR already has a review thread. */
  linkInReview: boolean;
  /** The link was chosen from the search: it's what is reviewed. */
  linkChosen: boolean;
  onUseLink: () => void;
}) {
  const { kind, pick, menu, onMenu, linkRead: read, linkChosen } = props;
  const linkPull = linkChosen && read?.ok ? read : null;
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Row>
        <Choices label="Review" name="kind" value={kind} onChange={props.onKind} options={[['local', 'Local'], ['pr', 'Pull request'], ['walkthrough', 'Walkthrough']]} />
      </Row>
      {kind === 'local' ? (
        <Row>
          <Choices label="Changes" name="changes" value={props.changes} onChange={props.onChanges} options={[['uncommitted', 'Uncommitted'], ['last', 'Last commit'], ['branch', 'Whole branch']]} />
          <SummaryLine summary={props.summary} />
        </Row>
      ) : kind === 'walkthrough' ? null : (
        <>
          <Row>
            <button ref={button} type="button" className="ib-cp-tobtn ib-cp-rvpick" aria-haspopup="listbox" aria-expanded={menu} aria-label={`Pull request: ${linkPull ? `${linkPull.pull.repo} ${inboxPullLabel(linkPull.pull)} ${linkPull.pull.title}` : linkChosen ? props.link : pick ? `${pick.label} ${pick.title}` : 'none chosen'}`} data-review-pick={linkPull?.pull.key ?? pick?.id ?? 'choose'} onClick={() => onMenu(!menu)}>
              {linkPull ? (
                <>
                  <RefMarkIcon kind="pr" state={linkStateWord(linkPull) ?? 'open'} size={14} />
                  <span className="ib-cp-tod">{linkPull.pull.repo}</span>
                  <span className="ib-cp-rvnum">{inboxPullLabel(linkPull.pull)}</span>
                  <b dir="auto">{linkPull.pull.title}</b>
                  {linkStateWord(linkPull) && <span className="ib-cp-tod">· {linkStateWord(linkPull)}</span>}
                </>
              ) : linkChosen ? (
                <span className="ib-cp-tod">{props.link}</span>
              ) : pick ? (
                <>
                  <RefMarkIcon kind="pr" state="open" size={14} />
                  <span className="ib-cp-tod">{pick.label}</span>
                  <b dir="auto">{pick.title}</b>
                </>
              ) : (
                <span className="ib-cp-tod">Choose or paste a pull request</span>
              )}
              <Icon name="chevD" size={15} />
            </button>
            {menu && (
              <PullMenu
                pulls={props.pulls}
                read={props.pullsRead}
                link={props.link}
                linkRead={read}
                linkInReview={props.linkInReview}
                onLink={props.onLink}
                onUseLink={props.onUseLink}
                selected={pick?.id ?? null}
                phone={props.phone}
                onPick={props.onPick}
                onClose={() => {
                  onMenu(false);
                  button.current?.focus();
                }}
              />
            )}
          </Row>
          {linkChosen && read && !menu && (
            <div className="ib-cp-rvread ib-cp-rvreadrow"><LinkReadLine read={read} inReview={props.linkInReview} /></div>
          )}
        </>
      )}
    </>
  );
}
