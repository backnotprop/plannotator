/**
 * The project rail on a phone (take R1's phone states): a phone has no room for a column, so with the rail on, the
 * pins head the sidebar's sheet as one row, in the rail's order, Inbox first, the place on show filled. A tap is the
 * sidebar's own handler for that place, and closes the sheet as its rows do. The rest of the sheet is today's.
 */
import type { SidebarPlaces } from '../sidebarPlaces';
import { inboxIsOn } from '../sidebarPlaces';
import { useSidebarLayout } from '../sidebarLayout';
import { railTiles } from './railModel';
import { RailTile } from './RailTile';
import { RAIL_WORDS } from './PlaceRail';

export function RailPinRow({ places, pick }: { places: SidebarPlaces; pick: (go: () => void) => () => void }) {
  const layout = useSidebarLayout();
  if (!layout.rail) return null;
  const { tiles } = railTiles(places, layout.pins ?? []);
  return (
    <nav className="ib-rail-pins" aria-label={RAIL_WORDS.nav} data-rail-pins="">
      <RailTile place={{ kind: 'inbox', name: 'Inbox', machine: null, count: places.inboxCount, on: inboxIsOn(places) }} onClick={pick(places.onInbox)} data-rail-place="inbox" />
      {tiles.map((tile) => (
        <RailTile key={tile.key} place={tile} onClick={pick(tile.go)} data-rail-place={tile.key} />
      ))}
    </nav>
  );
}
