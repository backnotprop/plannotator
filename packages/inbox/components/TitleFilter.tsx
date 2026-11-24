/**
 * Filter by typing (listTitleFilter.ts holds the rule, listTitleFilterStore.ts the state): a thin field under the
 * list's header that narrows the list by title as the person types.
 *
 * - The filter menu's first row opens it (ListFilter.tsx); nothing in the header changes and no key opens it.
 * - The menu's row flies to its place and becomes it while the list makes room (200 ms; titleFilterMotion.ts; none
 *   with reduced motion), pushing the list down by its own height only, and it takes focus. Placeholder and name
 *   "Filter by title"; an × at its end. Closing, it folds away (180 ms) with its words in it.
 * - Every key narrows the list in place: a group keeps its matches with its count following them, an emptied group
 *   goes, and nothing matching reads "No threads match" where the list would be. It narrows what the menu's picks
 *   left, a linked computer's threads too, and the Archived group when it shows.
 * - The × or Escape (only while the field has focus) empties it, takes it away, puts the list's scroll back where it
 *   was when the field opened, and focus back on the filter button.
 * - Only the list draws again as the person types (`useTitleFilterList`), never the window: one pass over the rows
 *   the list already holds, kept until the rows or the words change.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { inboxRowArchived } from '@plannotator/core/inbox-types';
import type { ArchivedGroupHost } from '../data/actions/archivedGroup';
import { Icon } from '../icons';
import { TITLE_FILTER_NONE, TITLE_FILTER_PLACEHOLDER, filterRowsByTitle, filterSectionsByTitle, titleWords } from '../listTitleFilter';
import { closeTitleFilter, freshTitleFilter, setTitleFilterText, settleTitleFilter, useTitleFilter } from '../listTitleFilterStore';
import { foldField, reducedMotion, travelToField } from './titleFilterMotion';

/** The ×'s name. */
const CLOSE_WORDS = 'Close filter';

/** The list holds a row a person would read: one outside the folded Snoozed band, not archived. */
const holdsRows = (sections: readonly InboxListSection[]) => sections.some((section) => section.id !== 'snoozed' && section.threads.some((row) => !inboxRowArchived(row)));

/**
 * The list's sections and Archived group narrowed by what is typed, with the field to draw under the header and what
 * to draw when nothing matches (null: the list's own empty words, if any). `on`: this list has the filter (the tour's
 * list does not).
 */
export function useTitleFilterList(sections: readonly InboxListSection[], archived: ArchivedGroupHost | undefined, on: boolean) {
  const { open, text } = useTitleFilter();
  const query = on && open ? text : '';
  const typed = titleWords(query).length > 0;
  const shown = useMemo(() => filterSectionsByTitle(sections, query), [sections, query]);
  const archivedShown = useMemo(
    () => (archived && typed ? { ...archived, filter: (rows: readonly InboxListRow[]) => filterRowsByTitle(archived.filter(rows), query) } : archived),
    [archived, typed, query],
  );
  // Nothing left by the words alone: when the picks already left nothing, the list's own empty words stay (Clear filters).
  const none = useMemo(() => typed && !holdsRows(shown) && holdsRows(sections), [typed, shown, sections]);
  const field: ReactNode = on && open ? <TitleFilterField text={text} /> : null;
  const empty: ReactNode = none ? (
    <div className="ib-empty-list" role="status" data-title-filter-none="">
      <b>{TITLE_FILTER_NONE}</b>
    </div>
  ) : null;
  return { sections: shown, archived: archivedShown, field, empty };
}

function TitleFilterField({ text }: { text: string }) {
  // Opened from the menu just now: it eases in and takes focus. Drawn again later (a thread closed, a reload), neither.
  const [enter] = useState(freshTitleFilter);
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
    // A copy folds away with the words in it; the field itself goes now, and the whole list with it comes back.
    if (box.current) foldField(box.current, text);
    const scroll = closeTitleFilter();
    // The whole list is drawn again in this task; its scroll goes back before the next paint.
    if (list && scroll !== null) requestAnimationFrame(() => (list.scrollTop = scroll));
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
              setTitleFilterText(event.currentTarget.value);
              // The matches start at the list's top.
              const list = column()?.querySelector<HTMLElement>('.ib-lbody');
              if (list) list.scrollTop = 0;
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
      </div>
    </div>
  );
}
