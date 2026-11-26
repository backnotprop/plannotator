/**
 * The list title's picker (the owner's pick "E · Title drop-down", 2026-11-26): a small ⌄ beside the list's title
 * opens a menu of the sidebar's places, so the list can change place without the sidebar. The title itself still
 * refreshes the list it names (InboxList.tsx); only the ⌄ opens this. No thread count beside the title (the owner:
 * "That's just useless"), and no shortcut of its own.
 *
 * - The menu: a find field ("Find a project or tag"), then Inbox with its count, then Tags, then Projects, each with
 *   its count. The places, their order, their names (another computer's project as "harbor · Laptop") and their
 *   counts are the sidebar's own (sidebarPlaces.ts); the place on screen is drawn as the menu's picked row.
 * - A pick runs the sidebar's own handler for that place (`onInbox`, the tag's `onOpen`, `onProject`), so it lands
 *   exactly where the same click in the sidebar does: the same route, list, remembered scroll, and the same open
 *   thread rule. Picking the place on screen refreshes it, as its sidebar row does.
 * - Typing narrows every section at once (the filter menu's matching, listFilterSearch.ts: case and accents ignored,
 *   the match bold); Inbox steps aside while words are typed. Enter in the field takes the first match. The field
 *   and its keys are the filter menu's long sections' (ListFilterSections.tsx `FindField`): ↓ to the rows, ↑ from the
 *   first row back, Escape empties it first, then closes.
 * - Base UI's menu: arrows, Home/End, Escape and Tab close, focus back to the ⌄; its Escape is used, so the window's
 *   Escape ladder (closing the open thread) never runs on it. Focus on open is the filter menu's (ListFilter.tsx): a
 *   click, tap or pen opens it with focus on the menu itself (a field's focus would raise a tablet's keyboard and turn
 *   the pointer's hover off), where a letter is Base UI's type-ahead over the rows; a desktop key (Enter, Space, ↓)
 *   puts focus in the field, so typing finds at once; a phone's sheet (the filter's) always takes focus itself.
 * - Nothing matching the words: the filter menu's line ("No tags match …", "No projects match …"), one per section.
 * - Every project and tag is listed, also when Customize sidebar hides its section: the picker is the way to switch
 *   without the sidebar.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Menu } from '@base-ui/react/menu';
import { formatCount } from '../format';
import { Icon } from '../icons';
import { searchHit } from '../listFilterSearch';
import { inboxIsOn, useShownProjects, type SidebarPlaces } from '../sidebarPlaces';
import { sortTags, useTagSort } from '../tagSort';
import { TagIcon } from './InitiativePeek';
import { FindField, lit, noProjectsMatch, noTagsMatch, NoneLine, rowKeyToField } from './ListFilterSections';
import { matchCount, useSaidAfterPause } from './saidAfterPause';
import { Tip } from './Tip';

/** The ⌄'s name and the menu's, for a screen reader and the tooltip. */
export const PLACE_PICKER_WORDS = 'Switch inbox';
/** The find field's words. */
export const PLACE_FIND_WORDS = 'Find a project or tag';
const POINTER_OPENS = ['mouse', 'touch', 'pen'];

interface Place {
  key: string;
  label: string;
  count: number;
  /** The place on screen. */
  on: boolean;
  go: () => void;
  mark: ReactNode;
}

/**
 * The sidebar's places, in its order, each going where its sidebar row goes. Deliberately not the sidebar's Customize
 * choices: a Tags or Projects section hidden there is still listed here (the picker switches without the sidebar).
 */
export function usePlaces(places: SidebarPlaces): { inbox: Place; tags: Place[]; projects: Place[] } {
  const { shown } = useShownProjects(places);
  const tagSort = useTagSort();
  // `shown`: the window has tags to list at all (useThreadTagsHost.ts), not the Customize sidebar choice.
  const tags = places.tags?.shown ? places.tags : null;
  const sortedTags = useMemo(() => (tags ? sortTags(tags.tags, tagSort, tagSort === 'recent' ? tags.activity : undefined) : []), [tags, tagSort]);
  const onList = places.page === 'inbox' || places.page === 'plans';
  return {
    inbox: { key: 'inbox', label: 'Inbox', count: places.inboxCount, on: inboxIsOn(places), go: places.onInbox, mark: <Icon name="inbox" /> },
    tags: sortedTags.map((tag) => ({
      key: `tag:${tag.id}`,
      label: tag.name,
      count: tags?.waiting.get(tag.id) ?? 0,
      on: places.page === 'inbox' && tags?.tagId === tag.id,
      go: () => tags?.onOpen(tag.id),
      mark: <TagIcon className="ib-ic" />,
    })),
    projects: shown.map((project) => ({
      key: `project:${project.id}`,
      label: project.name,
      count: places.projectCounts.get(project.id) ?? 0,
      on: onList && places.projectId === project.id,
      go: () => places.onProject(project.id),
      mark: <Icon name="folder" />,
    })),
  };
}

/**
 * The project rail's + (rail/PlaceRail.tsx) opens this same menu from its own button, with a pin on each tag and
 * project row: the pin puts the place on the rail or takes it off, the name still goes there.
 */
export interface PlacePins {
  /** The pinned places' keys (`tag:<id>`, `project:<id>`). */
  pinned: ReadonlySet<string>;
  onPin: (key: string, pinned: boolean) => void;
}
interface PickerTrigger {
  label: string;
  className: string;
  icon: ReactNode;
  /** The rail opens it beside the button; the title's ⌄ under it. */
  side: 'bottom' | 'right';
}

export function ListPlacePicker({ places, phone, pins, trigger: given }: { places: SidebarPlaces; phone: boolean; pins?: PlacePins; trigger?: PickerTrigger }) {
  const [open, setOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  if (!open && typing) setTyping(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useEffect(() => setPortal(trigger.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  // As the filter menu (ListFilter.tsx `POINTER_OPENS`): a click, tap or pen open, and a phone's sheet, focus the menu
  // itself, so no keyboard rises and the pointer's hover stays on. A desktop key open: the field, so typing finds at once.
  const menuFocus = (type: string) => phone || POINTER_OPENS.includes(type);
  const initialFocus = { initialFocus: (type: string) => (menuFocus(type) ? (popup.current ?? true) : (popup.current?.querySelector<HTMLInputElement>('input[data-list-filter-find]') ?? true)) };
  return (
    <Menu.Root open={open} onOpenChange={setOpen} modal={phone} highlightItemOnHover={!typing}>
      <Tip content={given?.label ?? PLACE_PICKER_WORDS} side={given?.side === 'right' ? 'right' : undefined}>
        <Menu.Trigger ref={trigger} className={given?.className ?? 'ib-lhead-switch'} aria-label={given?.label ?? PLACE_PICKER_WORDS} data-place-picker={given ? 'rail' : ''}>
          {given?.icon ?? <Icon name="chevD" size={phone ? 20 : 16} />}
        </Menu.Trigger>
      </Tip>
      <Menu.Portal container={portal ?? undefined}>
        {phone && <Menu.Backdrop className="ib-pm-scrim" />}
        {/* The filter menu's look and its phone sheet, field and all (`ib-lflt-menu`, `data-list-filter-fields`). */}
        <Menu.Positioner className="ib-pm-pos" side={given?.side ?? 'bottom'} align="start" sideOffset={6} data-phone={phone ? '' : undefined} data-list-filter-fields="">
          <Menu.Popup
            ref={popup}
            // `initialFocus` is absent from Base UI 1.9.0's public types, as in ListFilter.tsx (MenuPopup still passes it on).
            {...initialFocus}
            className="ib-pm ib-pc-menu ib-lflt-menu ib-place-menu"
            aria-label={given?.label ?? PLACE_PICKER_WORDS}
            onKeyDown={rowKeyToField}
            data-place-menu=""
            data-list-filter-fields=""
            data-list-filter-typing={typing ? '' : undefined}
          >
            <PlaceRows places={places} phone={phone} pins={pins} onTyping={setTyping} onPicked={() => setOpen(false)} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** The menu's rows, drawn only while it is open: the words typed start afresh with each open. */
function PlaceRows({ places, phone, pins, onTyping, onPicked }: { places: SidebarPlaces; phone: boolean; pins?: PlacePins; onTyping: (on: boolean) => void; onPicked: () => void }) {
  const [query, setQuery] = useState('');
  const all = usePlaces(places);
  const searching = query.trim() !== '';
  const keep = (list: readonly Place[]) => list.flatMap((place) => {
    const hit = searchHit(place.label, query);
    return !searching || hit ? [{ place, hit }] : [];
  });
  const tags = keep(all.tags);
  const projects = keep(all.projects);
  // Enter in the field: the first match (nothing before a word is typed).
  const first = searching ? [...tags, ...projects][0]?.place : undefined;
  const listId = useId();
  const matches = tags.length + projects.length;
  // Nothing matching: the filter menu's line for each section there is (Projects alone when there is neither).
  const none = searching && matches === 0 ? [...(all.tags.length > 0 ? [noTagsMatch(query.trim())] : []), ...(all.projects.length > 0 || all.tags.length === 0 ? [noProjectsMatch(query.trim())] : [])] : [];
  const said = useSaidAfterPause(!searching ? '' : matches > 0 ? matchCount(matches) : none.join('. '));
  const row = ({ place, hit }: { place: Place; hit: readonly [number, number] | null }) => {
    const item = nameRow({ place, hit });
    if (!pins || place.key === 'inbox') return item;
    const pinned = pins.pinned.has(place.key);
    // The rail's +: the row's pin beside its name, a checkbox of its own (the menu stays open on it).
    return (
      <div key={place.key} className="ib-place-pinrow" data-pinned={pinned ? '' : undefined}>
        {item}
        <Menu.CheckboxItem className="ib-pmi ib-place-pin" checked={pinned} closeOnClick={false} onCheckedChange={(next: boolean) => pins.onPin(place.key, next)} label={`Pin ${place.label}`} aria-label={`Pin ${place.label}`} data-place-pin={place.key}>
          <Icon name="pin" size={14} />
        </Menu.CheckboxItem>
      </div>
    );
  };
  const nameRow = ({ place, hit }: { place: Place; hit: readonly [number, number] | null }) => (
    <Menu.Item key={place.key} className="ib-pmi" label={place.label} onClick={place.go} data-checked={place.on ? '' : undefined} aria-current={place.on ? 'page' : undefined} data-place={place.key}>
      {place.mark}
      <span className="ib-pmi-l" dir="auto" data-hit={hit ? '' : undefined}>
        {lit(place.label, hit)}
      </span>
      {place.count > 0 && (
        <span className="ib-pmi-n">
          {formatCount(place.count)}
          {/* As the sidebar's rows say it (TagsSection.tsx). */}
          <span className="ib-sr"> waiting on you</span>
        </span>
      )}
    </Menu.Item>
  );
  return (
    <>
      <FindField
        section="places"
        words={PLACE_FIND_WORDS}
        value={query}
        controls={listId}
        phone={phone}
        onChange={setQuery}
        onTyping={onTyping}
        onEnter={() => {
          if (!first) return;
          first.go();
          onPicked();
        }}
      />
      <div id={listId}>
        {!searching && row({ place: all.inbox, hit: null })}
        {tags.length > 0 && (
          <Menu.Group data-place-group="tags">
            <Menu.GroupLabel className="ib-pm-glabel">Tags</Menu.GroupLabel>
            {tags.map(row)}
          </Menu.Group>
        )}
        {projects.length > 0 && (
          <Menu.Group data-place-group="projects">
            <Menu.GroupLabel className="ib-pm-glabel">Projects</Menu.GroupLabel>
            {projects.map(row)}
          </Menu.Group>
        )}
        {none.map((words) => (
          <NoneLine key={words} words={words} />
        ))}
      </div>
      <div className="ib-sr" role="status">
        {said}
      </div>
    </>
  );
}
