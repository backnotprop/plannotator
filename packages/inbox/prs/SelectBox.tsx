/**
 * Select mode's boxes on the Pull requests board (approval "inbox-pr-board-bulk"): a box that picks a group (a
 * repository, or the whole table), half-filled while only some of it is picked, and the mark drawn inside a tile or a
 * row, whose own click picks. Shown only in select mode.
 */
import type { MouseEvent as ReactMouseEvent } from 'react';
import { Icon } from '../icons';

export type BoxState = 'none' | 'some' | 'all';

export function boxState(keys: readonly string[], picked: ReadonlySet<string>): BoxState {
  const n = keys.filter((key) => picked.has(key)).length;
  return n === 0 ? 'none' : n === keys.length ? 'all' : 'some';
}

export function SelectBox({ state, label, tooltip, onClick }: { state: BoxState; label: string; tooltip?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      className="ib-prs-box"
      aria-checked={state === 'some' ? 'mixed' : state === 'all'}
      aria-label={label}
      title={tooltip ? label : undefined}
      data-on={state === 'none' ? undefined : ''}
      data-pr-select-all=""
      onClick={(event: ReactMouseEvent) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {state === 'some' ? (
        <svg className="ib-ic" viewBox="0 0 24 24" width={12} height={12} aria-hidden="true" focusable="false">
          <path d="M6 12h12" />
        </svg>
      ) : (
        <Icon name="check" size={12} />
      )}
    </button>
  );
}

/** The box inside a tile: the tile is the checkbox, so this is only its picture. */
export function BoxMark({ on }: { on: boolean }) {
  return (
    <span className="ib-prs-box" data-on={on ? '' : undefined} aria-hidden="true">
      <Icon name="check" size={10} />
    </span>
  );
}
