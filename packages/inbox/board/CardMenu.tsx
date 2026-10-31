import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import type { InboxCardColumn, InboxCardWire, InboxListRow } from '@plannotator/core/inbox-types';
import { Icon } from '../icons';
import { useContextMenuTrigger, type MenuSlot } from '../components/useContextMenuTrigger';
import { cardMenuItems, youThread, type CardMenuItem } from './model';

export interface CardMenuProps {
  className: string;
  /** Finds a card by its id (the menu is one for the whole Board body). */
  cardOf: (id: string) => InboxCardWire | null;
  rowOf: (threadId: string) => InboxListRow | null;
  /** The card whose menu is open (its hover look and a muted fill), or null when it closes. */
  onTarget: (id: string | null) => void;
  /** A lane, Shipped or Icebox picked (never the card's own column). */
  onColumn: (card: InboxCardWire, column: InboxCardColumn) => void;
  onRestore: (card: InboxCardWire) => void;
  /** Drop…: the card opens with its reason field open and focused. */
  onDrop: (card: InboxCardWire) => void;
  onOpenThread: (card: InboxCardWire, threadId: string) => void;
  children: ReactNode;
}

/** The card a `contextmenu` (or a key) at this target names: its own button (the title, `data-card-open`). */
function cardButtonOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest('.ib-bcard[data-card-id]')?.querySelector<HTMLElement>('[data-card-open]') ?? null;
}

/** The list a card sits in (a lane, the Shipped or Icebox list, a phone's group) and its heading. */
const LIST = '[data-lane], .ib-blist';
const LIST_HEADING = '.ib-lane-h, .ib-blist-h, .ib-bgroup-h button';

/**
 * A Board card's right-click menu (approval "inbox-board-card-menu", layout
 * A): one menu for the Board's body (`.ib-bmain`, the trigger), aimed at the
 * card the right-click (or the context-menu key, or Shift+F10, on a focused
 * card) lands on. Its items are `cardMenuItems`: Open thread, the opened
 * card's Move menu word for word (or Restore in the Icebox), Drop…. Anywhere
 * else on the body (empty lane space, a lane heading, the Dropped list, the
 * opened card) the browser's own menu shows; a touch never opens it. The
 * trigger's rules are the thread rows' (`useContextMenuTrigger`). Escape,
 * Tab or a move put focus on the card's own button in the lane it is in now;
 * a card that left the lanes hands focus to the card now in its slot, else
 * that list's heading. The look is the project menu's (`.ib-pm`).
 */
export function CardMenu(props: CardMenuProps) {
  const body = useRef<HTMLDivElement>(null);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(body.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  const cardEl = (id: string) => body.current?.querySelector<HTMLElement>(`.ib-bcard[data-card-id="${CSS.escape(id)}"]`) ?? null;
  const slotOf = (id: string): MenuSlot => {
    const list = cardEl(id)?.closest<HTMLElement>(LIST) ?? null;
    const order = list ? [...list.querySelectorAll('.ib-bcard[data-card-id]')].map((el) => el.getAttribute('data-card-id')!) : [];
    return { order, fallback: () => (list?.isConnected ? list.querySelector<HTMLElement>(LIST_HEADING) : null) };
  };
  const menu = useContextMenuTrigger({
    itemOf: cardButtonOf,
    idOf: (button) => button.closest('[data-card-id]')?.getAttribute('data-card-id') ?? null,
    // A dropped card has no menu (its row has Restore); one dropped while its menu is open closes it.
    has: (id) => {
      const card = props.cardOf(id);
      return card !== null && cardMenuItems(card, null).length > 0;
    },
    buttonFor: (id) => cardEl(id)?.querySelector<HTMLElement>('[data-card-open]') ?? null,
    slotOf,
    stateOf: (id) => props.cardOf(id)?.column ?? '',
    // A card moved to another lane is drawn again there: focus goes with it.
    followMoves: true,
    onTarget: props.onTarget,
  });
  const card = menu.targetId ? props.cardOf(menu.targetId) : null;
  const groups = card ? cardMenuItems(card, youThread(card, props.rowOf)) : [];
  const pick = (item: CardMenuItem) => {
    if (!card) return;
    switch (item.kind) {
      case 'thread':
        // The thread opens in the Inbox view: focus is its.
        menu.keepFocus();
        props.onOpenThread(card, item.threadId);
        return;
      case 'column':
        menu.follow(card.id);
        props.onColumn(card, item.column);
        return;
      case 'restore':
        menu.follow(card.id);
        props.onRestore(card);
        return;
      case 'drop':
        // The opened card's reason field takes focus.
        menu.keepFocus();
        props.onDrop(card);
        return;
    }
  };
  const plain = (item: Exclude<CardMenuItem, { kind: 'column' }>) => (
    <Menu.Item key={item.kind} className="ib-pmi" label={item.label} data-card-menu-action={item.kind} onClick={() => pick(item)}>
      <Icon name={item.kind === 'thread' ? 'arrowUpRight' : item.kind === 'restore' ? 'replay' : 'xCircle'} size={15} />
      {item.label}
    </Menu.Item>
  );
  const column = (item: Extract<CardMenuItem, { kind: 'column' }>) => (
    <Menu.RadioItem key={item.column} value={item.column} closeOnClick className="ib-pmi" label={item.label} data-card-menu-to={item.column}>
      {item.column === 'shipped' || item.column === 'icebox' ? (
        <Icon name={item.column === 'shipped' ? 'checkCircle' : 'snowflake'} size={15} />
      ) : (
        <span className="ib-lane-dot" data-col={item.column} aria-hidden="true" />
      )}
      {item.label}
      {item.current && <Icon name="check" size={15} className="ib-pmi-check" />}
    </Menu.RadioItem>
  );
  // The column groups (the lanes, then Shipped and Icebox) are one choice: one radio group, a line inside it.
  const columnGroups = groups.filter((group) => group[0]?.kind === 'column');
  const firstColumns = groups.findIndex((group) => group[0]?.kind === 'column');
  return (
    <ContextMenu.Root {...menu.root}>
      <ContextMenu.Trigger ref={body} className={props.className} {...menu.trigger}>
        {props.children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal container={portal ?? undefined}>
        <ContextMenu.Positioner className="ib-pm-pos">
          <ContextMenu.Popup className="ib-pm" aria-label={card?.title ?? 'Card'} data-card-context-menu={card?.id} {...menu.popup}>
            {card &&
              groups.map((group, index) => {
                if (group[0]?.kind === 'column' && index !== firstColumns) return null;
                return (
                  <Fragment key={index}>
                    {index > 0 && <Menu.Separator className="ib-pm-sep" />}
                    {index === firstColumns ? (
                      <Menu.RadioGroup
                        value={card.column}
                        onValueChange={(value: InboxCardColumn) => {
                          // The card's own column does nothing (as the Move menu).
                          if (value === card.column) return;
                          const item = columnGroups.flat().find((choice) => choice.kind === 'column' && choice.column === value);
                          if (item) pick(item);
                        }}
                        aria-label="Column"
                      >
                        {columnGroups.map((choices, at) => (
                          <Fragment key={at}>
                            {at > 0 && <Menu.Separator className="ib-pm-sep" />}
                            {choices.map((choice) => (choice.kind === 'column' ? column(choice) : null))}
                          </Fragment>
                        ))}
                      </Menu.RadioGroup>
                    ) : (
                      group.map((item) => (item.kind === 'column' ? null : plain(item)))
                    )}
                  </Fragment>
                );
              })}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
