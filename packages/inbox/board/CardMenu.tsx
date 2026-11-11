import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import type { InboxCardColumn, InboxCardWire, InboxInitiative, InboxListRow } from '@plannotator/core/inbox-types';
import { Icon } from '../icons';
import { useContextMenuTrigger, type MenuSlot } from '../components/useContextMenuTrigger';
import { cardMenuItems, youThread, type CardMenuItem } from './model';
import { CardInitiativeItems } from './BoardFilter';

export interface CardMenuProps {
  className: string;
  cardOf: (id: string) => InboxCardWire | null;
  rowOf: (threadId: string) => InboxListRow | null;
  onTarget: (id: string | null) => void;
  onColumn: (card: InboxCardWire, column: InboxCardColumn) => void;
  onRestore: (card: InboxCardWire) => void;
  onDrop: (card: InboxCardWire) => void;
  onOpenThread: (card: InboxCardWire, threadId: string) => void;
  initiatives?: readonly InboxInitiative[];
  onInitiative?: (card: InboxCardWire, initiative: string | null) => void;
  children: ReactNode;
}

function cardButtonOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest('.ib-bcard[data-card-id]')?.querySelector<HTMLElement>('[data-card-open]') ?? null;
}

const LIST = '[data-lane], .ib-blist';
const LIST_HEADING = '.ib-lane-h, .ib-blist-h, .ib-bgroup-h button';

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
    has: (id) => {
      const card = props.cardOf(id);
      return card !== null && cardMenuItems(card, null).length > 0;
    },
    buttonFor: (id) => cardEl(id)?.querySelector<HTMLElement>('[data-card-open]') ?? null,
    slotOf,
    stateOf: (id) => props.cardOf(id)?.column ?? '',
    followMoves: true,
    onTarget: props.onTarget,
  });
  const card = menu.targetId ? props.cardOf(menu.targetId) : null;
  const groups = card ? cardMenuItems(card, youThread(card, props.rowOf)) : [];
  const pick = (item: CardMenuItem) => {
    if (!card) return;
    switch (item.kind) {
      case 'thread':
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
      {item.column === 'done' ? (
        <Icon name="checkCircle" size={15} />
      ) : (
        <span className="ib-lane-dot" data-col={item.column} aria-hidden="true" />
      )}
      {item.label}
      {item.current && <Icon name="check" size={15} className="ib-pmi-check" />}
    </Menu.RadioItem>
  );
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
                const initiativeGroup = group[0]?.kind === 'drop' && props.onInitiative && (props.initiatives?.length ?? 0) > 0 && (
                  <>
                    <Menu.Separator className="ib-pm-sep" />
                    <Menu.SubmenuRoot>
                      <Menu.SubmenuTrigger className="ib-pmi" label="Initiative" data-card-menu-action="initiative">
                        <Icon name="hash" size={15} />
                        <span className="ib-pmi-l">Initiative</span>
                        <Icon name="chevR" size={14} className="ib-pmi-check" />
                      </Menu.SubmenuTrigger>
                      <Menu.Portal container={portal ?? undefined}>
                        <Menu.Positioner className="ib-pm-pos" side="right" align="start" sideOffset={2}>
                          <Menu.Popup className="ib-pm ib-bflt-menu" aria-label="Initiative" data-card-initiative-menu="">
                            <CardInitiativeItems initiatives={props.initiatives ?? []} value={card.initiative ?? null} onPick={(next) => {
                              menu.follow(card.id);
                              props.onInitiative?.(card, next);
                            }} />
                          </Menu.Popup>
                        </Menu.Positioner>
                      </Menu.Portal>
                    </Menu.SubmenuRoot>
                  </>
                );
                return (
                  <Fragment key={index}>
                    {initiativeGroup}
                    {index > 0 && <Menu.Separator className="ib-pm-sep" />}
                    {index === firstColumns ? (
                      <Menu.RadioGroup
                        value={card.column}
                        onValueChange={(value: InboxCardColumn) => {
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
