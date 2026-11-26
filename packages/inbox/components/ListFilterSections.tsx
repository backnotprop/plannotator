/**
 * The filter menu's rows (ListFilter.tsx builds them as sections; the owner, 2026-11-18: "for like long lists, either
 * tags or projects, … a limited height with the internal scroll bar … And then a type ahead where I type and then it
 * filters down to just those projects within that list").
 *
 * - A long section (Agent, Tag or Project with more than eight rows, listFilterSearch.ts) gets its own field under its
 *   heading ("Find an agent", "Find a tag", "Find a project") and a list of seven rows and half the eighth that scrolls
 *   inside the menu (the cut placed in CSS, the separator under the ticked rows counted: `--ib-lflt-pins`). The rows
 *   ticked when the menu opened, or when its field last changed, come first in that scroll (inside its cap, so forty
 *   ticked tags never stretch the section); a row ticked meanwhile stays where it is, so nothing moves under the
 *   pointer or the keyboard. Typing narrows that section only, the match bold (in a ticked row too); the first match,
 *   the row Enter acts on, is brought into view in the section's list as the words change (`showFirstMatch`); nothing
 *   matching says so in that section ("No projects match “zzz”"). An × empties the field.
 * - A section of eight rows or fewer is the plain menu's: no field, no cap. Nothing sits at the menu's top.
 * - Keys: the field is a stop in the menu's ↑ ↓ order, between its heading and its first row. ↓ from the field goes to
 *   the first row under it, ↑ from that row back to the field; at the inner list's ends the arrows go on to the next
 *   section, and wrap at the menu's ends as the plain menu does. In the field, letters, Space, Home and End are the
 *   field's (no type-ahead); Enter ticks or unticks the section's first match, focus and words staying (as the one
 *   field this replaced did); Escape empties it first, then closes the menu; Escape on a row of a section with words
 *   typed empties them and goes back to the field. During IME composition every key is the IME's. On the plain rows
 *   the menu's first-letter type-ahead works as always.
 * - While a field has focus the pointer only hovers rows (Base UI's hover would take focus from the field), and a
 *   click on a row gives focus back to the field, so typing goes on.
 * - Typing never moves the field: the menu keeps its scroll, a desktop menu growing shorter from its foot when its
 *   rows run out, a phone's sheet keeping its height (a spacer at its foot). On a phone the field's section comes to the
 *   sheet's top when the field takes focus and again as the keyboard rises, never once the person scrolls the sheet.
 * - Each field is a searchbox (role, name, aria-controls on its list), as Base UI's Menu.Input is.
 * - A screen reader hears the count of the section typed in ("3 matches") once typing pauses (saidAfterPause.ts).
 *
 * Only drawn while the menu is open: its state (the words, the pins) starts afresh with each open.
 */
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import { formatCount } from '../format';
import { Icon } from '../icons';
import { findInSection, labelStart, type FilterSearchRow, type SectionFind } from '../listFilterSearch';
import { matchCount, useSaidAfterPause } from './saidAfterPause';

/** One row of the menu: a pick, or (`opens`, its Base UI label) a row that opens something (Custom range…, Title…). */
export interface FilterRow {
  key: string;
  label: string;
  on: boolean;
  count: number | null;
  onToggle: () => void;
  mark: React.ReactNode;
  data: Record<string, string>;
  opens?: string;
}
export interface FilterSection {
  id: string;
  /** Null: no group label (Not seen). */
  title: string | null;
  rows: FilterRow[];
  /** A section that can grow long: its field's words, and the line when nothing matches. */
  find?: { words: string; none: (query: string) => string };
}

/** The ×'s name, for a screen reader's touch or virtual cursor (Escape does the same from the keyboard). */
const CLEAR_WORDS = 'Clear search';
const NO_PINS: ReadonlySet<string> = new Set();

/** The Tag and Project sections' line when their find matches nothing (ListFilter.tsx), and the title picker's. */
export const noTagsMatch = (query: string) => `No tags match “${query}”`;
export const noProjectsMatch = (query: string) => `No projects match “${query}”`;

/** The visible line under a find that matches nothing. */
export function NoneLine({ words }: { words: string }) {
  return (
    <div className="ib-lflt-none" data-list-filter-none="">
      {words}
    </div>
  );
}

const tick = (on: boolean) => <span className="ib-pc-tick">{on && <Icon name="check" />}</span>;

/** A row's label with the match drawn bold, from `labelStart` ("…" for what it drops). */
export function lit(label: string, hit: readonly [number, number] | null) {
  if (!hit) return label;
  const from = labelStart(label, hit);
  return (
    <>
      {from > 0 && <span aria-hidden="true">…</span>}
      {label.slice(from, hit[0])}
      <b className="ib-lflt-hit">{label.slice(hit[0], hit[1])}</b>
      {label.slice(hit[1])}
    </>
  );
}

/** A row; `first`: the section's first match, the row Enter in its field acts on (`showFirstMatch` keeps it in view). */
function drawRow({ row, hit }: FilterSearchRow<FilterRow>, first = false) {
  if (row.opens) {
    return (
      <Menu.Item key={row.key} className="ib-pmi" label={row.opens} onClick={row.onToggle} data-checked={row.on ? '' : undefined} {...row.data}>
        {row.mark}
        <span className="ib-pmi-l">{row.label}</span>
        {row.count !== null && <span className="ib-pmi-n">{formatCount(row.count)}</span>}
        {tick(row.on)}
      </Menu.Item>
    );
  }
  const count = row.count ?? 0;
  return (
    <Menu.CheckboxItem
      key={row.key}
      className="ib-pmi"
      label={row.label}
      aria-label={labelStart(row.label, hit) > 0 ? `${row.label} ${formatCount(count)}` : undefined}
      checked={row.on}
      onCheckedChange={row.onToggle}
      closeOnClick={false}
      data-list-filter-first={first ? '' : undefined}
      {...row.data}
    >
      {row.mark}
      {/* `data-hit`: a ticked row's label drops to the plain rows' weight, so its match is drawn bold as theirs is. */}
      <span className="ib-pmi-l" dir="auto" data-hit={hit ? '' : undefined}>
        {lit(row.label, hit)}
      </span>
      <span className="ib-pmi-n">{formatCount(count)}</span>
      {tick(row.on)}
    </Menu.CheckboxItem>
  );
}

const plain = (row: FilterRow): FilterSearchRow<FilterRow> => ({ row, hit: null });

/** The section's first row matching its words, in the order drawn (a matching ticked row first); none with no words. */
const firstMatch = (f: SectionFind<FilterRow>): FilterSearchRow<FilterRow> | undefined => (f.searching ? (f.pinned.find((p) => p.hit) ?? f.rows[0]) : undefined);

/** The places ↑ ↓ stop at, in the menu's order: its rows and its sections' fields. */
const STOPS = '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], input[data-list-filter-find]';
const isRow = (el: Element | null): el is HTMLElement => !!el && /^menuitem/.test(el.getAttribute('role') ?? '');
const isField = (el: Element | null): el is HTMLInputElement => !!el && el.matches('input[data-list-filter-find]');

/** The stop before or after `from` in the menu (this one, or the list title's picker), wrapping at its ends as the plain menu does. */
export function stepFrom(from: HTMLElement, by: 1 | -1): HTMLElement | null {
  const menu = from.closest('[data-list-filter-menu], [data-place-menu]');
  if (!menu) return null;
  const stops = [...menu.querySelectorAll<HTMLElement>(STOPS)];
  const at = stops.indexOf(from);
  if (at < 0 || stops.length < 2) return null;
  return stops[(at + by + stops.length) % stops.length]!;
}

/** Focus on `to`, scrolled into view in its section's list and in the menu (never the page's own scroll jump). */
function goTo(to: HTMLElement | null) {
  if (!to) return;
  to.focus({ preventScroll: true });
  to.scrollIntoView?.({ block: 'nearest' });
}

/**
 * The section's first match (the row Enter acts on) brought into view in its own list as the words change: forty
 * ticked rows pinned above would leave it below the cut. Only that list scrolls (never the menu or the page), at once
 * (no motion), and only when the row is not already in full view; it then sits under the lower half of the row before
 * it, so the ticked rows above still show. One read of layout per change of the words, none per render.
 */
export function showFirstMatch(list: HTMLElement) {
  const row = list.querySelector<HTMLElement>('[data-list-filter-first]');
  if (!row) return;
  const box = list.getBoundingClientRect();
  const at = row.getBoundingClientRect();
  const top = at.top - box.top + list.scrollTop;
  if (top >= list.scrollTop && top + at.height <= list.scrollTop + list.clientHeight) return;
  const rows = [...list.querySelectorAll<HTMLElement>('.ib-pmi')];
  const before = rows[rows.indexOf(row) - 1];
  if (!before) {
    list.scrollTop = 0;
    return;
  }
  const above = before.getBoundingClientRect();
  list.scrollTop = Math.max(0, Math.round(above.top - box.top + list.scrollTop + above.height / 2));
}

/**
 * ↑ ↓ on a row of the menu that would land on a field: done here (Base UI's menu knows only its rows). Every other
 * key, and every other ↑ ↓, is Base UI's. ListFilter.tsx puts this on the menu's popup, ahead of Base UI's handlers.
 */
export function rowKeyToField(event: React.KeyboardEvent<HTMLElement> & { preventBaseUIHandler?: () => void }) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
  const from = event.target as HTMLElement;
  if (!isRow(from)) return;
  const to = stepFrom(from, event.key === 'ArrowDown' ? 1 : -1);
  if (!isField(to)) return;
  event.preventDefault();
  event.preventBaseUIHandler?.();
  event.stopPropagation();
  goTo(to);
}

/**
 * The menu keeps its scroll (`scrollTop`) as a field's rows change, so the field stays under the pointer or thumb.
 * Rows running out would make the browser pull the scroll back: a desktop menu instead grows shorter from its foot;
 * a phone's sheet keeps its height and a spacer at its foot takes the rows' place.
 */
export function holdScroll(menu: HTMLElement, scrollTop: number, spacer: HTMLElement | null) {
  if (spacer) spacer.style.height = '';
  else menu.style.maxHeight = '';
  const short = scrollTop - (menu.scrollHeight - menu.clientHeight);
  if (short > 0) {
    if (spacer) spacer.style.height = `${Math.ceil(short)}px`;
    else menu.style.maxHeight = `${menu.offsetHeight - short}px`;
  }
  menu.scrollTop = scrollTop;
}

/** How much shorter the visual viewport must get to be the keyboard rising, not its suggestion bar changing. */
const KEYBOARD_RISE_PX = 120;
/** How long after the viewport's last step the keyboard counts as up (its steps come a frame or so apart). */
const KEYBOARD_SETTLE_MS = 120;

/** What `bringUp` reads of `window.visualViewport`. */
type ViewportLike = Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & { readonly height: number };

/**
 * A phone: the field's section at the sheet's top when the field takes focus, and again as the keyboard rises (the
 * visual viewport getting at least `KEYBOARD_RISE_PX` shorter than at focus; once, after its last step) and the sheet
 * comes to sit on it. Nothing else moves it: a suggestion bar coming or going is not the keyboard rising, and once
 * the person scrolls the sheet themselves (a touch, a pen or the wheel anywhere but the field) it is theirs until the
 * field next takes focus.
 */
export function bringUp(input: HTMLInputElement, viewport: ViewportLike | null = typeof window !== 'undefined' ? window.visualViewport : null): () => void {
  const menu = input.closest<HTMLElement>('[data-list-filter-menu]');
  const group = input.closest<HTMLElement>('[data-list-filter-long]');
  if (!menu || !group) return () => {};
  const lift = () => {
    const pad = parseFloat(getComputedStyle(menu).paddingTop) || 0;
    menu.scrollTop += group.getBoundingClientRect().top - menu.getBoundingClientRect().top - pad;
  };
  lift();
  if (!viewport) return () => {};
  const atFocus = viewport.height;
  let theirs = false;
  /** The keyboard is up (the viewport `KEYBOARD_RISE_PX` or more shorter than at focus). */
  let up = false;
  /** The keyboard is still rising: the lift waits for its last step. */
  let rising: ReturnType<typeof setTimeout> | undefined;
  const onResize = () => {
    if (atFocus - viewport.height < KEYBOARD_RISE_PX) {
      // Down again (or never up): the next rise lifts again.
      up = false;
      clearTimeout(rising);
      rising = undefined;
      return;
    }
    // Already up and settled: a suggestion bar coming or going, never a lift.
    if (up && rising === undefined) return;
    up = true;
    clearTimeout(rising);
    // Once the keyboard has stopped rising and the sheet sits on it (phone.ts trackKeyboard sets that in a frame).
    rising = setTimeout(() => {
      rising = undefined;
      if (!theirs && input.isConnected) lift();
    }, KEYBOARD_SETTLE_MS);
  };
  // The field's own box (the field, its ×) is not the sheet.
  const box = input.closest('[data-list-filter-find-box]') ?? input;
  const own = (event: Event) => {
    if (!(event.target instanceof Node && box.contains(event.target))) theirs = true;
  };
  const moves = ['touchstart', 'pointerdown', 'wheel'] as const;
  viewport.addEventListener('resize', onResize);
  for (const name of moves) menu.addEventListener(name, own, { capture: true, passive: true });
  /** Ends it: on blur, or (WebKit fires no blur when a focused node is removed) when the field goes with the menu. */
  const stop = () => {
    viewport.removeEventListener('resize', onResize);
    clearTimeout(rising);
    rising = undefined;
    for (const name of moves) menu.removeEventListener(name, own, { capture: true });
    input.removeEventListener('blur', stop);
  };
  input.addEventListener('blur', stop);
  return stop;
}

/** A find field in a menu: the filter's long sections, and the list title's picker (ListPlacePicker.tsx). */
export function FindField({
  section,
  words,
  value,
  controls,
  phone,
  onChange,
  onTyping,
  onEnter,
}: {
  section: string;
  words: string;
  value: string;
  controls: string;
  phone: boolean;
  onChange: (text: string) => void;
  onTyping: (on: boolean) => void;
  /** Enter: tick or untick the section's first match, if there is one. */
  onEnter: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  /** The phone's lift while the field has focus (`bringUp`): ended on blur, and as the menu closes with focus here. */
  const lifting = useRef<(() => void) | null>(null);
  const endLift = () => {
    lifting.current?.();
    lifting.current = null;
  };
  useEffect(() => endLift, []);
  return (
    <div className="ib-lflt-find" data-list-filter-find-box="">
      <Icon name="search" />
      <input
        ref={input}
        type="text"
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        onFocus={(event) => {
          onTyping(true);
          endLift();
          if (phone) lifting.current = bringUp(event.currentTarget);
        }}
        onBlur={() => {
          endLift();
          onTyping(false);
        }}
        onKeyDown={(event) => {
          // During IME composition every key is the IME's: no step, no emptying, no close.
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
            event.stopPropagation();
            return;
          }
          // Tab is the browser's (the next field, or out of the menu, which closes it); Escape on an empty field
          // closes the menu as always.
          if (event.key === 'Tab' || (event.key === 'Escape' && value === '')) return;
          // Everything else is the field's: letters and Space type, Home and End move the caret, no type-ahead.
          event.stopPropagation();
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            goTo(stepFrom(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1));
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onChange('');
          } else if (event.key === 'Enter') {
            // As the one field this replaced did: the first match ticks or unticks; focus and the words stay. A held
            // Enter acts once (its repeats would flip the row on and off).
            event.preventDefault();
            if (!event.repeat) onEnter();
          }
        }}
        // A search field, as Base UI's Menu.Input is (role searchbox, aria-controls on its list), so a screen reader in
        // a menu knows it is for typing. Menu.Input itself needs Menu.FilterProvider, one field over the whole menu.
        role="searchbox"
        aria-label={words}
        placeholder={words}
        aria-controls={controls}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        dir="auto"
        data-list-filter-find={section}
      />
      {value !== '' && (
        <button
          type="button"
          className="ib-lflt-clear"
          aria-label={CLEAR_WORDS}
          tabIndex={-1}
          // The field keeps focus (and a phone its keyboard).
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onChange('');
            input.current?.focus({ preventScroll: true });
          }}
          data-list-filter-find-clear=""
        >
          <Icon name="x" />
        </button>
      )}
    </div>
  );
}

/** The ticked rows of each long section, kept above its scroll. */
const pinsOf = (sections: readonly FilterSection[], long: ReadonlySet<string>, only?: string) => {
  const pins: Record<string, ReadonlySet<string>> = {};
  for (const section of sections) if (long.has(section.id) && (only === undefined || only === section.id)) pins[section.id] = new Set(section.rows.filter((row) => row.on).map((row) => row.key));
  return pins;
};

export function FilterMenuRows({
  sections,
  long,
  onClear,
  phone,
  onTyping,
}: {
  sections: readonly FilterSection[];
  /** The sections drawn long (fixed while the menu is open, ListFilter.tsx). */
  long: ReadonlySet<string>;
  /** Clear filters; null: nothing is picked, no row. */
  onClear: (() => void) | null;
  phone: boolean;
  /** A field has focus (true) or lost it. */
  onTyping: (on: boolean) => void;
}) {
  const [queries, setQueries] = useState<Readonly<Record<string, string>>>({});
  const [pins, setPins] = useState(() => pinsOf(sections, long));
  /** The section typed in last: its count is the one said. */
  const [last, setLast] = useState<string | null>(null);
  const status = useRef<HTMLDivElement>(null);
  const spacer = useRef<HTMLDivElement>(null);
  /** The menu's scroll as the words changed, put back once the rows are drawn. */
  const held = useRef<number | null>(null);
  /** A field that had focus as the pointer pressed one of its rows: it gets focus back after the click. */
  const back = useRef<HTMLInputElement | null>(null);
  const idBase = useId();

  /** The section whose words changed: its first match is brought into view once its rows are drawn. */
  const changed = useRef<string | null>(null);

  const setQuery = (id: string, text: string) => {
    held.current = status.current?.closest<HTMLElement>('[data-list-filter-menu]')?.scrollTop ?? null;
    changed.current = id;
    setPins((was) => ({ ...was, ...pinsOf(sections, long, id) }));
    setQueries((was) => ({ ...was, [id]: text }));
    setLast(id);
  };
  useLayoutEffect(() => {
    const menu = status.current?.closest<HTMLElement>('[data-list-filter-menu]');
    const id = changed.current;
    changed.current = null;
    if (!menu) return;
    if (held.current !== null) holdScroll(menu, held.current, phone ? spacer.current : null);
    held.current = null;
    const list = id === null ? null : menu.querySelector<HTMLElement>(`[data-list-filter-long="${id}"] [data-list-filter-scroll]`);
    if (list) showFirstMatch(list);
  }, [queries, phone]);

  const drawn = sections.filter((section) => section.rows.length > 0);
  const found = new Map(drawn.filter((s) => long.has(s.id) && s.find).map((s) => [s.id, findInSection(s.rows, queries[s.id] ?? '', pins[s.id] ?? NO_PINS)]));
  const lastFound = last === null ? undefined : found.get(last);
  const lastSection = drawn.find((s) => s.id === last);
  const words = lastFound?.searching ? (lastFound.matches > 0 ? matchCount(lastFound.matches) : lastSection!.find!.none((queries[last!] ?? '').trim())) : '';
  const said = useSaidAfterPause(words);

  return (
    <>
      {drawn.map((section, i) => {
        const f = found.get(section.id);
        const query = queries[section.id] ?? '';
        const listId = `${idBase}-${section.id}`;
        const first = f && firstMatch(f);
        const parted = !!f && f.pinned.length > 0 && (f.rows.length > 0 || f.matches === 0);
        return (
          <Fragment key={section.id}>
            {i > 0 && <Menu.Separator className="ib-pm-sep" />}
            {section.title === null ? (
              section.rows.map((row) => drawRow(plain(row)))
            ) : f && section.find ? (
              <Menu.Group
                data-list-filter-group={section.id === 'projects' ? undefined : section.id}
                data-list-filter-long={section.id}
                onPointerDownCapture={(event) => {
                  const active = document.activeElement;
                  back.current = event.pointerType === 'mouse' && isField(active) && event.currentTarget.contains(active) && isRow((event.target as Element).closest(STOPS)) ? active : null;
                }}
                onClick={() => {
                  const field = back.current;
                  back.current = null;
                  // After Base UI has put focus on the clicked row.
                  if (field) requestAnimationFrame(() => field.isConnected && field.focus({ preventScroll: true }));
                }}
                onKeyDown={(event) => {
                  // Escape on a row here, with words typed: the words go first and focus goes back to the field.
                  if (event.key !== 'Escape' || query === '' || !isRow(event.target as Element)) return;
                  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                  event.preventDefault();
                  event.stopPropagation();
                  setQuery(section.id, '');
                  goTo(event.currentTarget.querySelector<HTMLElement>('input[data-list-filter-find]'));
                }}
              >
                <Menu.GroupLabel className="ib-pm-glabel">{section.title}</Menu.GroupLabel>
                <FindField
                  section={section.id}
                  words={section.find.words}
                  value={query}
                  controls={listId}
                  phone={phone}
                  onChange={(text) => setQuery(section.id, text)}
                  onTyping={onTyping}
                  onEnter={() => first?.row.onToggle()}
                />
                {/* The ticked rows first, inside the same capped scroll, so a section never grows past its cap. Its
                    cap (inbox.css) counts the separator under them when it sits above the cut: `--ib-lflt-pins`. */}
                <div
                  id={listId}
                  className="ib-lflt-scroll"
                  data-list-filter-scroll=""
                  style={parted ? ({ '--ib-lflt-pins': f.pinned.length } as React.CSSProperties) : undefined}
                >
                  {f.pinned.length > 0 && (
                    <div className="ib-lflt-pins" data-list-filter-pins="">
                      {f.pinned.map((item) => drawRow(item, item === first))}
                    </div>
                  )}
                  {parted && <div className="ib-pm-sep" aria-hidden="true" />}
                  <div data-list-filter-rows="">{f.rows.map((item) => drawRow(item, item === first))}</div>
                </div>
                {f.searching && f.matches === 0 && <NoneLine words={section.find.none(query.trim())} />}
              </Menu.Group>
            ) : (
              <Menu.Group data-list-filter-group={section.id === 'projects' ? undefined : section.id}>
                <Menu.GroupLabel className="ib-pm-glabel">{section.title}</Menu.GroupLabel>
                {section.rows.map((row) => drawRow(plain(row)))}
              </Menu.Group>
            )}
          </Fragment>
        );
      })}
      {onClear && (
        <>
          {drawn.length > 0 && <Menu.Separator className="ib-pm-sep" />}
          <Menu.Item className="ib-pmi" onClick={onClear} data-list-filter-clear="">
            <Icon name="x" />
            <span className="ib-pmi-l">Clear filters</span>
          </Menu.Item>
        </>
      )}
      <div ref={status} className="ib-sr" role="status" data-list-filter-find-status="">
        {said}
      </div>
      {phone && <div ref={spacer} aria-hidden="true" data-list-filter-spacer="" />}
    </>
  );
}
