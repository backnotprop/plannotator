import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { formatCount } from '../format';
import { AuthorMark, Icon } from '../icons';
import { pinnedLabel, pinnedRowName, pinnedState } from '../pins';
import { rowAgent } from './InboxList';
import { Tip } from './Tip';

/** What a pinned row's menu does. */
export type PinnedAction = 'unpin' | 'up' | 'down' | 'copy-link';

export interface PinnedRowProps {
  row: InboxListRow;
  /** The project as the sidebar names it (shortProjectNames). Absent: the server's name. */
  project?: string;
  /** The thread on screen: the list's selection pill and `aria-current`. */
  on: boolean;
  /** First or last pin: Move up or Move down is disabled. */
  first: boolean;
  last: boolean;
  /** A phone: ⋯ always shown, the menu a sheet from the bottom edge titled by the row's label, no right-click. */
  phone: boolean;
  onOpen: () => void;
  onAction: (action: PinnedAction) => void;
}

/**
 * One pinned thread in the sidebar (approval "inbox-pinned-threads", variant
 * Count): the agent's mark, the thread's name or else the subject (cut with
 * "…"; the whole label, the subject if it differs, and its project in a component tooltip), then the state, the way a project row
 * shows its count: a Stopped or Holds N pill in the badges' tints, the open
 * questions, a dot for news, or nothing when nothing waits on the person (the
 * row steps back); an archived thread shows the archive glyph. Bold when the
 * list row would be. ⋯ beside it (the project row's pattern: two buttons side
 * by side) opens Unpin, Move up, Move down and Copy link; a right-click on the
 * row opens the same menu. On a phone ⋯ is always shown, 44 px, and the menu
 * is a bottom sheet titled by the row's label.
 */
export function PinnedRow(props: PinnedRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(more.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  const { row } = props;
  const project = props.project ?? row.project.name;
  const state = pinnedState(row);
  const subject = row.subject ?? '(no subject)';
  const label = pinnedLabel(row);
  const items = (
    <PinnedMenuItems
      subject={label}
      first={props.first}
      last={props.last}
      onAction={(action) => {
        setMenuOpen(false);
        setContextOpen(false);
        props.onAction(action);
      }}
    />
  );
  const tail =
    state.kind === 'stop' ? (
      <span className="ib-spill" data-k="stop" aria-hidden="true">
        Stopped
      </span>
    ) : state.kind === 'hold' ? (
      <span className="ib-spill" data-k="hold" aria-hidden="true">
        Holds {formatCount(state.n)}
      </span>
    ) : state.kind === 'wait' ? (
      <span className="ib-n" aria-hidden="true">
        {formatCount(state.n)}
      </span>
    ) : state.kind === 'new' ? (
      <span className="ib-pdot" data-k="new" aria-hidden="true" />
    ) : state.kind === 'archived' ? (
      <span className="ib-parch" aria-hidden="true">
        <Icon name="archive" size={13} />
      </span>
    ) : null;
  const row_ = (children: ReactNode, extra: Record<string, unknown> = {}) => (
    <div className="ib-pinrow" data-pin={row.thread_id} data-menu={menuOpen || contextOpen ? '' : undefined} {...extra}>
      {children}
    </div>
  );
  const content = (
    <>
      <Tip side="right" content={<PinnedTipText label={label} subject={subject} project={project} state={state.words} />}>
        <button
          type="button"
          className={`ib-pin${row.unread ? ' ib-u' : ''}${state.calm ? ' ib-calm' : ''}${props.on ? ' ib-on' : ''}`}
          onClick={props.onOpen}
          aria-label={pinnedRowName(row, project)}
          aria-current={props.on ? 'true' : undefined}
          data-pinned-row={row.thread_id}
          data-state={state.kind}
        >
          <AuthorMark author={rowAgent(row)} />
          <span className="ib-name" dir="auto">
            {label}
          </span>
          {tail}
        </button>
      </Tip>
      <Menu.Root open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <Menu.Trigger ref={more} className="ib-pmore" aria-label={`${label} options`} data-pin-more={row.thread_id}>
          <Icon name="dots" size={16} />
        </Menu.Trigger>
        <Menu.Portal container={portal ?? undefined}>
          {props.phone && <Menu.Backdrop className="ib-pm-scrim" />}
          <Menu.Positioner className="ib-pm-pos" side="bottom" align="start" sideOffset={4} data-phone={props.phone ? '' : undefined}>
            <Menu.Popup className="ib-pm" aria-label={label} data-pin-menu={row.thread_id}>
              {items}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </>
  );
  if (props.phone) return row_(content);
  return (
    <ContextMenu.Root onOpenChange={setContextOpen}>
      <ContextMenu.Trigger render={row_(content)} />
      <ContextMenu.Portal container={portal ?? undefined}>
        <ContextMenu.Positioner className="ib-pm-pos">
          {/* Focus goes back to the row's ⋯, never the page. */}
          <ContextMenu.Popup className="ib-pm" aria-label={label} data-pin-menu={row.thread_id} finalFocus={more}>
            {items}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function PinnedMenuItems({ subject, first, last, onAction }: { subject: string; first: boolean; last: boolean; onAction: (action: PinnedAction) => void }) {
  return (
    <>
      {/* The popup is named by the label already (aria-label): the title is for the eye only (a phone's sheet). */}
      <div className="ib-pm-title" dir="auto" aria-hidden="true">
        {subject}
      </div>
      <Menu.Item className="ib-pmi" label="Unpin" onClick={() => onAction('unpin')} data-pin-action="unpin">
        <Icon name="pinOff" size={15} />
        Unpin
      </Menu.Item>
      <Menu.Item className="ib-pmi" label="Move up" disabled={first} onClick={() => onAction('up')} data-pin-action="up">
        <Icon name="arrowUp" size={15} />
        Move up
      </Menu.Item>
      <Menu.Item className="ib-pmi" label="Move down" disabled={last} onClick={() => onAction('down')} data-pin-action="down">
        <Icon name="arrowDown" size={15} />
        Move down
      </Menu.Item>
      <Menu.Separator className="ib-pm-sep" />
      <Menu.Item className="ib-pmi" label="Copy link" onClick={() => onAction('copy-link')} data-pin-action="copy-link">
        <Icon name="link" size={15} />
        Copy link
      </Menu.Item>
    </>
  );
}

/** A pinned row's tooltip: the whole label (the row may cut it), the subject when it differs, then project and state. */
function PinnedTipText({ label, subject, project, state }: { label: string; subject: string; project: string; state: string }) {
  return (
    <span className="ib-tip-proj" data-pin-tip="">
      <bdi className="ib-tip-name">{label}</bdi>
      {label !== subject && (
        <span className="ib-tip-sub" data-pin-tip-subject="">
          <bdi>{subject}</bdi>
        </span>
      )}
      <span className="ib-tip-sub">
        <bdi>{project}</bdi> · {state}
      </span>
    </span>
  );
}
