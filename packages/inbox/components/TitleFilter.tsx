/**
 * Filter by typing (listTitleFilter.ts holds the rule, listTitleFilterStore.ts the state): a thin field under the
 * list's header that narrows the list by title as the person types.
 *
 * - The filter menu's first row opens it (ListFilter.tsx); nothing in the header changes and no key opens it.
 * - The menu's row flies to its place and becomes it while the list makes room (200 ms; titleFilterMotion.ts; none
 *   with reduced motion), from the menu or a phone's sheet, pushing the list down by its own height only, and it takes
 *   focus. Placeholder and name "Filter by title"; an × at its end. Closing, it folds away (180 ms) with its words in it.
 * - Every key narrows the list in place: a group keeps its matches with its count following them, an emptied group
 *   goes, and only when nothing at all matches (the folded Snoozed band and the Archived group included) does "No
 *   threads match" read where the list would be. It narrows what the menu's picks left, a linked computer's threads
 *   too, and the Archived group when it shows. A row that stops matching shrinks and fades (titleFilterRows.ts).
 * - A screen reader hears how many threads match once typing pauses, as the menu's own find fields say theirs
 *   (saidAfterPause.ts); nothing is added on screen.
 * - The × or Escape (only while the field has focus) empties it, takes it away while the whole list comes back in the
 *   same motion, puts the list's scroll back where it was when the field opened in this list (no other list's), and
 *   focus back on the filter button.
 * - Only the list draws again as the person types (`useTitleFilterList`), never the window: one pass over the rows
 *   the list already holds, kept until the rows or the words change.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { inboxRowArchived } from '@plannotator/core/inbox-types';
import type { ArchivedGroupHost } from '../data/actions/archivedGroup';
import { Icon } from '../icons';
import { TITLE_FILTER_NONE, TITLE_FILTER_PLACEHOLDER, filterRowsByTitle, filterSectionsByTitle, titleWords } from '../listTitleFilter';
import { closeTitleFilter, freshTitleFilter, setTitleFilterText, settleTitleFilter, useTitleFilter } from '../listTitleFilterStore';
import { foldField, reducedMotion, travelToField } from './titleFilterMotion';
import { LEAVE_MS, RETURN_MS, playListChange, shootList } from './titleFilterRows';
import { matchCount, useSaidAfterPause } from './saidAfterPause';

/** The ×'s name. */
const CLOSE_WORDS = 'Close filter';

/** The list holds a row a person would read: one outside the folded Snoozed band, not archived. */
const holdsRows = (sections: readonly InboxListSection[]) => sections.some((section) => section.id !== 'snoozed' && section.threads.some((row) => !inboxRowArchived(row)));

/**
 * The list's sections and Archived group narrowed by what is typed, with the field to draw under the header and what
 * to draw where the list's own empty words go (undefined: those words; null: nothing). `on`: this list has the filter
 * (the tour's list does not). `place`: which list this is (the sidebar's view). `archivedMatches`: the rows the
 * Archived group draws now (already narrowed by the words; 0 when it is hidden).
 */
export function useTitleFilterList(sections: readonly InboxListSection[], archived: ArchivedGroupHost | undefined, on: boolean, place: string, archivedMatches: number) {
  const { open, text } = useTitleFilter();
  const query = on && open ? text : '';
  const typed = titleWords(query).length > 0;
  const shown = useMemo(() => filterSectionsByTitle(sections, query), [sections, query]);
  const archivedShown = useMemo(
    () => (archived && typed ? { ...archived, filter: (rows: readonly InboxListRow[]) => filterRowsByTitle(archived.filter(rows), query) } : archived),
    [archived, typed, query],
  );
  // Every thread the words leave: every group's, the folded Snoozed band's and the Archived group's. Both are read only
  // while words are typed: a closed or empty field costs the list nothing when its rows change.
  const matches = useMemo(() => (typed ? shown.reduce((n, section) => n + section.threads.length, 0) : 0), [typed, shown]) + archivedMatches;
  // The picks left rows to narrow: else the list's own empty words stay (Clear filters).
  const picksLeft = useMemo(() => typed && holdsRows(sections), [typed, sections]);
  const field: ReactNode = on && open ? <TitleFilterField text={text} place={place} words={typed ? (matches === 0 ? TITLE_FILTER_NONE : matchCount(matches)) : ''} /> : null;
  // Words typed over rows: "No threads match" only when nothing at all matches; matches in the Snoozed band or the
  // Archived group alone draw no words above them.
  const empty: ReactNode | undefined = !typed || !picksLeft ? undefined : matches === 0 ? (
    <div className="ib-empty-list" data-title-filter-none="">
      <b>{TITLE_FILTER_NONE}</b>
    </div>
  ) : null;
  return { sections: shown, archived: archivedShown, field, empty };
}

function TitleFilterField({ text, place, words }: { text: string; place: string; words: string }) {
  // Opened from the menu just now: it eases in and takes focus. Drawn again later (a thread closed, a reload), neither.
  const [enter] = useState(freshTitleFilter);
  const said = useSaidAfterPause(words);
  const box = useRef<HTMLDivElement>(null);
  const find = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // Before the first paint: the menu's row starts its flight to here (titleFilterMotion.ts).
  useLayoutEffect(() => {
    if (enter && find.current) travelToField(find.current, TITLE_FILTER_PLACEHOLDER);
  }, [enter]);
  useEffect(() => {
    if (!enter) return;
    settleTitleFilter();
    if (document.activeElement !== input.current) input.current?.focus({ preventScroll: true });
  }, [enter]);
  const column = () => box.current?.closest('.ib-listcol') ?? null;
  const close = () => {
    const col = column();
    const list = col?.querySelector<HTMLElement>('.ib-lbody') ?? null;
    // Focus first, while the field still holds it: back on the filter button.
    col?.querySelector<HTMLElement>('.ib-lhead [data-list-filter]')?.focus({ preventScroll: true });
    const shot = shootList(list);
    // A copy folds away with the words in it; the field itself goes now, and the whole list with it comes back.
    if (box.current) foldField(box.current, text);
    const scroll = flushSync(() => closeTitleFilter(place));
    // Drawn whole now: its scroll goes back (this list's own, if it opened here) before the next paint.
    if (list && scroll !== null) list.scrollTop = scroll;
    playListChange(shot, RETURN_MS);
  };
  return (
    <div ref={box} className="ib-tflt" role="search" data-enter={enter && !reducedMotion() ? '' : undefined} data-title-filter="">
      <div className="ib-tflt-in">
        <div ref={find} className="ib-lflt-find">
          <Icon name="search" />
          <input
            ref={input}
            type="text"
            value={text}
            onChange={(event) => {
              const list = column()?.querySelector<HTMLElement>('.ib-lbody');
              const shot = shootList(list);
              flushSync(() => setTitleFilterText(event.currentTarget.value));
              // The matches start at the list's top.
              if (list) list.scrollTop = 0;
              playListChange(shot, LEAVE_MS);
            }}
            onKeyDown={(event) => {
              // During IME composition Escape is the IME's (it cancels the composition).
              if (event.key !== 'Escape' || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              event.preventDefault();
              event.stopPropagation();
              close();
            }}
            aria-label={TITLE_FILTER_PLACEHOLDER}
            placeholder={TITLE_FILTER_PLACEHOLDER}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            dir="auto"
            data-title-filter-input=""
          />
          <button type="button" className="ib-lflt-clear" aria-label={CLOSE_WORDS} onClick={close} data-title-filter-close="">
            <Icon name="x" />
          </button>
        </div>
        <div className="ib-sr" role="status" data-title-filter-status="">
          {said}
        </div>
      </div>
    </div>
  );
}
