/**
 * The project rail (the owner's pick "R1 · The rail is the closed sidebar", 2026-11-26; mock
 * project-rail-20261126/mocks/R1-rail-for-closed-sidebar.html). An optional mode, off by default: Settings → General
 * or the sidebar's right-click, "When the sidebar is closed: Keep a rail of places" (RailChoice.tsx). While the sidebar
 * is open nothing changes; closed, instead of nothing, this thin column stays at the left edge (shell/SidebarShell.tsx
 * draws it; a phone has no column, its sheet heads with the pins instead, RailPinRow.tsx).
 *
 * - Inbox with its count, then the pinned places (railModel.ts), each with what waits there; a click runs the
 *   sidebar's own handler for that place (sidebarPlaces.ts), so the window becomes that place exactly as the same
 *   click in the sidebar makes it. Nothing pinned: Recent, the places where something waits.
 * - + opens the list title's picker (ListPlacePicker.tsx) with a pin on each row. A pin's right-click: Mark all as
 *   read (a project's own), Move up, Move down, Unpin. A pin drags to a new place. Many pins scroll.
 * - The foot: Agents (its count: agents stopped on the person, as the sidebar's Agents heading counts) and ⋯, which
 *   both open the whole sidebar over the list: today's edge peek (shell/SidebarPeek.tsx), not a second flyout.
 * - A right-click anywhere else on the rail: the choice again, and Open the sidebar.
 * - Resting on a pin shows what waits there (RailPeekCard.tsx).
 * - No keyboard shortcut of its own. No thread count beside the list title (the owner: "useless").
 */
import { useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { inboxSidebarMovePin, inboxSidebarPin } from '@plannotator/core/inbox-sidebar';
import { Icon } from '../icons';
import { GogglesMark } from '../agents/AgentsSection';
import { agentsGroups } from '../agents/model';
import { useAgentStatusOn } from '../agents/agentStatus';
import { useInboxAgents } from '../agentsList';
import { formatCount } from '../format';
import type { MachinesModel } from '../machines';
import type { ProjectAction } from '../projectMenu';
import { inboxIsOn, type SidebarPlaces } from '../sidebarPlaces';
import { readSidebarLayout, useSidebarLayout, writeSidebarLayout } from '../sidebarLayout';
import { ListPlacePicker } from '../components/ListPlacePicker';
import { Tip } from '../components/Tip';
import { railTiles, type RailPlace } from './railModel';
import { RailTile } from './RailTile';
import { RailMenus, type RailMenuAt } from './RailMenus';
import { RailPeekCard, useRailPeek } from './RailPeekCard';
import { movedPins } from './railDrag';

/** What the window hands the rail (App.tsx): the sidebar's places and what its foot and cards read. */
export interface RailHost {
  places: SidebarPlaces;
  machines: MachinesModel;
  /** Every row the window has (App's `windowRows`): the agents' count and the pins' cards. */
  rows: readonly InboxListRow[];
  /** The projects where Mark all as read has something to do. */
  readable: ReadonlySet<string>;
  onProjectAction: (projectId: string, action: ProjectAction) => unknown;
}

export const RAIL_WORDS = { nav: 'Places', pin: 'Pin a project or tag', agents: 'Agents', more: 'The whole sidebar', recent: 'Recent' } as const;

export function PlaceRail({ host, shown, onMore }: { host: RailHost; shown: boolean; onMore: (opener: HTMLElement) => void }) {
  const { places } = host;
  const layout = useSidebarLayout();
  const pins = layout.pins ?? [];
  const { recent, tiles } = railTiles(places, pins);
  const [menu, setMenu] = useState<RailMenuAt | null>(null);
  const [drag, setDrag] = useState<{ key: string; order: readonly string[] } | null>(null);
  const peek = useRailPeek(menu === null && drag === null);
  const pinned = useMemo(() => new Set(pins), [pins]);
  const drawn = drag ? drag.order.flatMap((key) => tiles.find((tile) => tile.key === key) ?? []) : tiles;
  const moreRef = useRef<HTMLButtonElement>(null);

  const openMenu = (event: MouseEvent<HTMLElement>, place: RailPlace | null) => {
    event.preventDefault();
    peek.hide();
    // From the keyboard (Shift+F10, the menu key) there is no pointer: under the focused control.
    const keyboard = event.clientX === 0 && event.clientY === 0;
    const rect = keyboard ? event.currentTarget.getBoundingClientRect() : null;
    const x = rect ? rect.right - 8 : event.clientX;
    const y = rect ? rect.top + 8 : event.clientY;
    setMenu({ anchor: { getBoundingClientRect: () => new DOMRect(x, y, 0, 0) }, place, pinned: place ? pinned.has(place.key) : false, opener: event.currentTarget });
  };

  const dragProps = (tile: RailPlace) =>
    recent
      ? {}
      : {
          draggable: true,
          onDragStart: (event: DragEvent<HTMLButtonElement>) => {
            peek.hide();
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', tile.label);
            setDrag({ key: tile.key, order: pins });
          },
          onDragOver: (event: DragEvent<HTMLButtonElement>) => {
            if (!drag) return;
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            const order = movedPins(drag.order, drag.key, tile.key, event.clientY > rect.top + rect.height / 2);
            if (order.join('\n') !== drag.order.join('\n')) setDrag({ key: drag.key, order });
          },
          onDrop: (event: DragEvent<HTMLButtonElement>) => {
            event.preventDefault();
            if (drag) void writeSidebarLayout(inboxSidebarMovePin(readSidebarLayout(), drag.key, drag.order.indexOf(drag.key)));
            setDrag(null);
          },
          onDragEnd: () => setDrag(null),
        };

  const agentsWaiting = useAgentsWaiting(host);
  return (
    <nav className="ib-rail" aria-label={RAIL_WORDS.nav} data-shown={shown ? '' : undefined} inert={!shown} onContextMenu={(event) => openMenu(event, null)} data-place-rail="">
      <div className="ib-rail-scroll">
        <Tip content="Inbox" side="right">
          <RailTile place={{ kind: 'inbox', name: 'Inbox', machine: null, count: places.inboxCount, on: inboxIsOn(places) }} onClick={places.onInbox} data-rail-place="inbox" />
        </Tip>
        <span className="ib-rail-div" aria-hidden="true" />
        {recent && tiles.length > 0 && <span className="ib-rail-cap">{RAIL_WORDS.recent}</span>}
        {drawn.map((tile) => (
          <RailTile
            key={tile.key}
            place={tile}
            onClick={tile.go}
            onContextMenu={(event) => {
              event.stopPropagation();
              openMenu(event, tile);
            }}
            onPointerEnter={(event) => peek.rest(tile, event.currentTarget)}
            onPointerLeave={peek.hide}
            data-rail-place={tile.key}
            data-rail-recent={recent ? '' : undefined}
            data-dragging={drag?.key === tile.key ? '' : undefined}
            {...dragProps(tile)}
          />
        ))}
        <ListPlacePicker
          places={places}
          phone={false}
          pins={{ pinned, onPin: (key, on) => void writeSidebarLayout(inboxSidebarPin(readSidebarLayout(), key, on)) }}
          trigger={{ label: RAIL_WORDS.pin, className: 'ib-rail-btn', icon: <Icon name="plus" size={16} />, side: 'right' }}
        />
      </div>
      <div className="ib-rail-foot">
        <Tip content={RAIL_WORDS.agents} side="right">
          <button type="button" className="ib-rail-btn" onClick={(event) => onMore(event.currentTarget)} data-rail-agents={agentsWaiting} aria-label={agentsWaiting > 0 ? `${RAIL_WORDS.agents}, ${formatCount(agentsWaiting)} waiting on you` : RAIL_WORDS.agents}>
            <GogglesMark />
            {agentsWaiting > 0 && (
              <span className="ib-rail-n" aria-hidden="true">
                {formatCount(agentsWaiting)}
              </span>
            )}
          </button>
        </Tip>
        <Tip content={RAIL_WORDS.more} side="right">
          <button ref={moreRef} type="button" className="ib-rail-btn" aria-label={RAIL_WORDS.more} onClick={(event) => onMore(event.currentTarget)} data-rail-more="">
            <Icon name="dots" size={16} />
          </button>
        </Tip>
      </div>
      <RailMenus at={menu} host={host} onClose={() => setMenu(null)} />
      <RailPeekCard peek={peek.at} rows={host.rows} />
    </nav>
  );
}

/** Agents stopped on the person, counted as the sidebar's Agents heading counts them (AgentsSection.tsx). */
function useAgentsWaiting(host: RailHost): number {
  const groups = useInboxAgents();
  const statusOn = useAgentStatusOn();
  return useMemo(() => {
    if (!statusOn) return 0;
    return agentsGroups(groups, host.machines, host.rows, statusOn).reduce((n, group) => n + group.agents.filter((entry) => entry.agent.status_mark?.state === 'blocked').length, 0);
  }, [groups, host.machines, host.rows, statusOn]);
}
