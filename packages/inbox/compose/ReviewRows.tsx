import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import type { InboxReviewChanges } from '@plannotator/core/inbox-types';
import { Icon } from '../icons';
import { RefMarkIcon } from '../board/RefMark';
import { plural } from '@plannotator/core/inbox-format';
import type { ReviewBoxPull, ReviewSummary } from './reviewBox';

export type ReviewKind = 'local' | 'pr';

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

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="ib-cp-to ib-cp-rvrow">
    <span className="ib-cp-tol">{label}</span>
    {children}
  </div>
);

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

/** The picker over what Reviews lists: FolderMenu's look and keys. Not reviewed comes first; a PR in review opens its thread. */
function PullMenu({ pulls, selected, phone, onPick, onClose }: { pulls: readonly ReviewBoxPull[]; selected: string | null; phone: boolean; onPick: (pull: ReviewBoxPull) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const options = useMemo(() => {
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
          aria-label="Find a pull request"
          placeholder="Find a pull request"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setHl(0);
          }}
        />
      </div>
      <div className="ib-cp-list" role="listbox" id={`ib-cp-plist-${uid}`} aria-label="Pull requests">
        {options.length === 0 && <div className="ib-cp-none">{pulls.length === 0 ? 'No open pull requests.' : 'No pull request matches.'}</div>}
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
  pick: ReviewBoxPull | null;
  onPick: (pull: ReviewBoxPull) => void;
  phone: boolean;
  menu: boolean;
  onMenu: (open: boolean) => void;
}) {
  const { kind, pick, menu, onMenu } = props;
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Row label="Review">
        <Choices label="Review" name="kind" value={kind} onChange={props.onKind} options={[['local', 'Local changes'], ['pr', 'Open pull request']]} />
      </Row>
      {kind === 'local' ? (
        <Row label="Changes">
          <Choices label="Changes" name="changes" value={props.changes} onChange={props.onChanges} options={[['uncommitted', 'Uncommitted'], ['last', 'Last commit'], ['branch', 'Whole branch']]} />
          <SummaryLine summary={props.summary} />
        </Row>
      ) : (
        <Row label="Pull request">
          <button ref={button} type="button" className="ib-cp-tobtn" aria-haspopup="listbox" aria-expanded={menu} data-review-pick={pick?.id ?? 'choose'} onClick={() => onMenu(!menu)}>
            {pick ? (
              <>
                <RefMarkIcon kind="pr" state="open" size={14} />
                <span className="ib-cp-tod">{pick.label}</span>
                <b dir="auto">{pick.title}</b>
              </>
            ) : (
              <span className="ib-cp-tod">Choose a pull request</span>
            )}
            <Icon name="chevD" size={15} />
          </button>
          {menu && (
            <PullMenu
              pulls={props.pulls}
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
      )}
    </>
  );
}
