/**
 * Inbox search's palette (the approved "inbox-search" design, SPEC section 3,
 * after Workspaces' ui/command.tsx and search/GlobalSearchPalette.tsx).
 * Loaded lazily (components/SearchHost.tsx), mounted on the first open and
 * kept mounted after, so it never rides the window's first paint.
 *
 * A native modal <dialog> (focus trap, Escape, click outside, focus back to
 * what opened it), pinned to the upper part of the window, a full-screen
 * sheet on a phone. The input is a combobox over one listbox of groups; the
 * keyboard model is the open palette's own (no window shortcut): ↓ ↑ move a
 * highlight that wraps, Enter opens (never during IME composition), ⌘Enter
 * or Ctrl+Enter opens in a new tab, Escape closes a chip's menu, then the
 * palette. The highlight snaps to the first row when the rows change, never
 * while arrowing, and `pointermove` (not enter) moves it. Queries debounce
 * 120 ms, one request in flight, stale answers dropped; the last results stay
 * dimmed while the next are on their way.
 *
 * The Type chip (approval "inbox-search-type-filter", option B) leads the
 * filter row. With All types the request and the groups are what they were
 * before it; a picked type sends `group=<id>` on every query and lists that
 * group alone, 50 at a time. It starts on All types at every open.
 */

import { Fragment, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { INBOX_SEARCH_GROUPS, middleCutInboxName, type InboxSearchGroupId, type InboxSearchRow, type InboxSearchSort } from '@plannotator/core/inbox-search';
import { inboxApi, saveRecentSearch, searchInbox, type SearchModel } from '../api';

import { HostMark, Icon } from '../icons';
import { ShapeThumb } from '@plannotator/ui/components/shape/ShapeGrid';
import { KeyCaps } from '../shortcuts/hint';
import { isTextCut, ProjectTipText, Tip } from '../components/Tip';
import { actionLabel, busyWord, namesActionWord, startedLine, type ComposeAction } from '../compose/model';
import {
  FROM_OPTIONS,
  GROUP_LABELS,
  NO_FILTERS,
  SEARCH_PAGE,
  STATUS_OPTIONS,
  chipText,
  countWords,
  filtersSet,
  formatCount,
  markedRuns,
  moreLabel,
  projectMarks,
  projectNames,
  resultTarget,
  rowThreadChip,
  scopeWords,
  searchTime,
  searchGroups,
  searchRowMark,
  type SearchShape,
  sectionLabel,
  termMarks,
  typeCountWords,
  type SearchFilters,
  type SearchGroupView,
  type SearchOption,
  type RowThreadChip,
} from './model';
import { readSearchSort, SEARCH_SORT_OPTIONS, setSearchSort, useSearchSort } from './searchSort';

/** How long typing settles before a query goes out. */
export const SEARCH_DEBOUNCE_MS = 120;
/** How soon an answer that says the index is still building is asked again. */
export const SEARCH_INDEXING_RETRY_MS = 350;

export interface SearchLanding {
  messageId: string;
  terms: string[];
  questionKey: string | null;
}

export interface SearchPaletteProps {
  open: boolean;
  /** The window's phone layout: a full-screen sheet with Cancel. */
  phone: boolean;
  /** The project open in the list: its results come first on ties. Search still starts everywhere (owner, 2026-11-06). */
  currentProject: string | null;
  /** The projects for the Project chip, with their names as the person reads them. */
  projects: readonly { id: string; name: string; root: string; display_name?: unknown }[];
  /**
   * The list's project names, given while machines are linked: another machine's project reads as the list reads it
   * ("billing-svc · MacBook"), in its rows and the Project chip. Absent: the palette names the projects itself.
   */
  projectLabels?: ReadonlyMap<string, string>;
  /** `opened`: a result opened here (focus goes to it); `dismissed`: focus goes back to what opened the palette. */
  onClose: (reason: 'dismissed' | 'opened') => void;
  /** Open a result in this tab: the window writes the hash (a new history entry) and lands on the message. */
  onOpenResult: (hash: string, land: SearchLanding | null) => void;
  /**
   * Compose's actions for the words typed (the Actions group, above the
   * results): "New message…", "Message <host> in <project>". Absent: none.
   */
  actions?: (q: string) => ComposeAction[];
  /** An action chosen: the palette closes and the window opens compose. */
  onAction?: (action: ComposeAction) => void;
  /** Shape's boards the words find (the "Shape" group, under the results). Absent: none (Shape off). */
  shapes?: (q: string) => SearchShape[];
}

type FilterKind = keyof SearchFilters;
/** A chip and its menu: the three filters, and the Type chip that leads them. */
type ChipKind = FilterKind | 'type';

interface Answered {
  /** The query and filters this answer is for. */
  key: string;
  q: string;
  model: SearchModel;
  /** The filters it was asked with: the "Searched only" line names these, not the chips' newer picks still on their way. */
  filters: SearchFilters;
  /** The type it was asked for (null: All types). The list draws an answer as its own type, so a pick still on its way never redraws the last answer under the new chip. */
  type: InboxSearchGroupId | null;
  /** The order it was asked in ("Show all" pages go on in it). */
  sort: InboxSearchSort;
}

const FOCUSABLE = 'input:not([disabled]), button:not([disabled]):not([tabindex="-1"])';

function Marked({ text, marks }: { text: string; marks: readonly [number, number][] }) {
  return (
    <>
      {markedRuns(text, marks).map((run, i) =>
        run.mark ? (
          <strong key={i} className="ib-sp-m">
            {run.text}
          </strong>
        ) : (
          <span key={i}>{run.text}</span>
        ),
      )}
    </>
  );
}

/** The query's words marked in a field the answer carries no marks for (`termMarks`: the server's rule, the answer's terms). */
function Words({ text, terms }: { text: string; terms: readonly string[] }) {
  return terms.length > 0 ? <Marked text={text} marks={termMarks(text, terms)} /> : <>{text}</>;
}

/** No terms (the recent view, filters with no words): one array, so the memoized rows keep their props. */
const NO_TERMS: readonly string[] = [];
/** No marks: a field the row's document does not index. */
const NO_MARKS: readonly [number, number][] = [];

/** A composed secondary line (a project row's): each part apart, user-written parts in <bdi>; it wraps, never cut (the folder is searched). */
function Secondary({ parts }: { parts: readonly (ReactNode | null | false)[] }) {
  const shown = parts.filter((p): p is ReactNode => p !== null && p !== false && p !== '');
  return (
    <span className="ib-sp-s">
      {shown.map((part, i) => (
        <span key={i}>
          {i > 0 && ' · '}
          {part}
        </span>
      ))}
    </span>
  );
}

/**
 * The thread chip (`.ib-key` / `.ib-keyt`, drawn as plain words in the row's
 * face and a "·", approval "inbox-search-calm"): the thread's name, or, for a
 * thread with no name, its subject. Its tooltip and accessible words carry the whole thread:
 * "Thread nightly-deploy: Investigate why…" (always for a named thread, whose
 * subject is not on screen; a subject chip only while it is cut). Its words are
 * shown whole (they wrap inside the chip) with the query's words marked, so a
 * thread found by its name says why.
 */
function ThreadChip({ chip, terms }: { chip: RowThreadChip; terms: readonly string[] }) {
  const whole = chip.kind === 'name' && chip.subject ? `${chip.text}: ${chip.subject}` : chip.text;
  const named = chip.kind === 'name' && Boolean(chip.subject);
  return (
    <Tip content={`Thread: ${whole}`} when={named ? undefined : (trigger) => isTextCut(trigger.querySelector('.ib-keyt'))}>
      <span className={`ib-key ib-sp-key${chip.kind === 'subject' ? ' ib-sp-key-subj' : ''}`} data-result-thread={chip.kind}>
        <span className="ib-sr">Thread: </span>
        <bdi className="ib-keyt" dir="auto">
          <Words text={chip.text} terms={terms} />
        </bdi>
        {chip.kind === 'name' && chip.subject && <span className="ib-sr">, {chip.subject}</span>}
        <span className="ib-sr">, </span>
      </span>
    </Tip>
  );
}

/**
 * A result's second line: the thread chip first (where a phone's list row
 * draws it, ahead of what the thread holds), then what the result is (its
 * author or folder), the project, the section, the time, apart
 * by "·" (", " for a screen reader). Nothing is cut: the chip and the project
 * show their whole words and the line wraps after a "·" (a `<wbr>`) when they
 * do not fit, never before one: each part holds the "·" after it (a line never
 * starts with one). The section and the time never break inside. Each user-written part is a `<bdi dir="auto">`.
 * The chip and the project carry marks only on a thread row (`chipTerms`,
 * `projectMarks`): a message, file or guide row was not found by them.
 */
function MetaLine({ chip, chipTerms, lead, project, projectMarks, section, at }: { chip: RowThreadChip | null; chipTerms: readonly string[]; lead?: ReactNode; project: string; projectMarks: readonly [number, number][]; section?: string | null; at?: string | null }) {
  const parts: { node: ReactNode; className: string }[] = [];
  if (lead) parts.push({ node: lead, className: 'ib-sp-lead' });
  parts.push({
    node: (
      <bdi dir="auto">
        <Marked text={project} marks={projectMarks} />
      </bdi>
    ),
    className: 'ib-sp-pj',
  });
  if (section) parts.push({ node: section, className: 'ib-sp-sec' });
  if (at) parts.push({ node: at, className: 'ib-sp-at' });
  return (
    <span className="ib-sp-s ib-sp-tl">
      {chip && <ThreadChip chip={chip} terms={chipTerms} />}
      {chip && <wbr />}
      {parts.map((part, i) => (
        <Fragment key={i}>
          {/* A part keeps its "·" (no break between them), and the line may break after it. */}
          <span className={part.className}>
            {part.node}
            {i < parts.length - 1 && (
              <>
                <span className="ib-sp-sep" aria-hidden="true">
                  ·
                </span>
                <span className="ib-sr">, </span>
              </>
            )}
          </span>
          {i < parts.length - 1 && <wbr />}
        </Fragment>
      ))}
    </span>
  );
}

/**
 * The mark a result row starts with (`searchRowMark`): the agent's mark for a
 * message, an outline for what the row is otherwise. Decorative: the row's
 * words say the same, so it is hidden from a screen reader.
 */
function RowMark({ row }: { row: InboxSearchRow }) {
  const mark = searchRowMark(row);
  return (
    <span className="ib-sp-mark" data-row-mark={mark.kind === 'agent' ? `agent:${mark.host ?? ''}` : mark.icon} aria-hidden="true">
      {mark.kind === 'agent' ? <HostMark host={mark.host} /> : <Icon name={mark.icon} />}
    </span>
  );
}

/** A row's time in its own right-hand column (desktop; a phone keeps it at the end of the meta line). */
function TimeColumn({ at }: { at: string | null }) {
  if (!at) return null;
  return (
    <span className="ib-sp-time" data-result-time="">
      <span className="ib-sr">, </span>
      {at}
    </span>
  );
}

/**
 * "Best match | Newest" (approval "inbox-search-sort"): the Inbox's segmented control (`.ib-seg`), native radios in a
 * radiogroup, so Tab reaches the chosen one and the arrows choose. The pick is this browser's (searchSort.ts).
 */
function SortSwitch({ sort, onChange, name }: { sort: InboxSearchSort; onChange: (sort: InboxSearchSort) => void; name: string }) {
  return (
    <span className="ib-seg ib-sp-sort" role="radiogroup" aria-label="Order results by" data-search-sort={sort}>
      {SEARCH_SORT_OPTIONS.map((option) => (
        <label key={option.value} className="ib-seg-o" data-on={sort === option.value ? '' : undefined} data-sort={option.value}>
          <input type="radio" name={name} value={option.value} checked={sort === option.value} onChange={() => onChange(option.value)} />
          {option.label}
        </label>
      ))}
    </span>
  );
}

/** The palette's key footer (desktop): only keys the palette already handles, the new-tab chord in the platform's own modifier. */
function KeyFooter() {
  return (
    <div className="ib-sp-foot" data-search-keys="" aria-hidden="true">
      <span>
        <KeyCaps bindings={['ArrowUp', 'ArrowDown']} /> Move
      </span>
      <span>
        <KeyCaps bindings={['Enter']} /> Open
      </span>
      <span>
        <KeyCaps bindings={['Mod+Enter']} /> Open in new tab
      </span>
      <span className="ib-sp-foot-end">
        <KeyCaps bindings={['Escape']} /> Close
      </span>
    </div>
  );
}

/** A result's mark and lines. Memoized: moving the highlight re-renders the option elements, not what they hold
 *  (the row is the answer's own object, so it stays the same until a new answer lands). */
const ResultContent = memo(function ResultContent({ row, phone, projectName, terms }: { row: InboxSearchRow; phone: boolean; projectName: string; terms: readonly string[] }) {
  return (
    <>
      <RowMark row={row} />
      <RowBody row={row} phone={phone} projectName={projectName} terms={terms} />
    </>
  );
});

function RowBody({ row, phone, projectName, terms }: { row: InboxSearchRow; phone: boolean; projectName: string; terms: readonly string[] }) {
  const chip = rowThreadChip(row);
  // The time: in its own column on a desktop, at the end of the meta line on a phone (a column would take the title's width).
  const time = row.type === 'project' ? null : searchTime(row.at);
  const metaAt = phone ? time : null;
  switch (row.type) {
    case 'thread': {
      const label = row.archived || row.section === 'stopped' ? null : sectionLabel(row.section);
      return (
        <>
          <span className="ib-sp-rs">
            <span className="ib-sp-p" dir="auto">
              <Marked text={row.title} marks={row.title_marks} />
            </span>
            {/* The thread's document indexes its subject, its name and its project's name: the chip and the project are marked. */}
            <MetaLine chip={chip} chipTerms={terms} project={projectName} projectMarks={projectMarks(projectName, row.project.name, terms)} section={label} at={metaAt} />
          </span>
          {row.archived ? <span className="ib-sp-chip">Archived</span> : row.section === 'stopped' ? <span className="ib-sp-chip ib-sp-warn">Stopped</span> : null}
          {!phone && <TimeColumn at={time} />}
        </>
      );
    }
    case 'message':
      return (
        <>
          <span className="ib-sp-rs">
            <span className="ib-sp-p ib-sp-snip" dir="auto">
              <Marked text={row.snippet.text} marks={row.snippet.marks} />
            </span>
            {/* A message's document indexes its body, its questions and its agent's name: only the agent is marked. */}
            <MetaLine
              chip={chip}
              chipTerms={NO_TERMS}
              lead={
                row.author.kind === 'me' ? (
                  'You'
                ) : (
                  <bdi dir="auto">
                    <Words text={row.author.name} terms={terms} />
                  </bdi>
                )
              }
              project={projectName}
              projectMarks={NO_MARKS}
              at={metaAt}
            />
          </span>
          {/* An action item (an Inbox `:::action`, key `a-…`) reads "Action item", not "Question". */}
          {row.question && <span className="ib-sp-chip">{row.question.key.startsWith('a-') ? 'Action item' : 'Question'}</span>}
          {row.question?.replaced && <span className="ib-sp-chip">Replaced</span>}
          {row.archived && <span className="ib-sp-chip">Archived</span>}
          {!phone && <TimeColumn at={time} />}
        </>
      );
    case 'file':
    case 'guide': {
      // Cut in the middle to fit, unless the cut would take a matched word: then the whole name, wrapped.
      const short = middleCutInboxName(row.name, phone ? 30 : 46, row.name_marks);
      const cut = short.marks.length < row.name_marks.length ? { text: row.name, marks: row.name_marks } : short;
      return (
        <>
          <span className="ib-sp-rs">
            {/* The name is cut in its middle here (JS): the whole name whenever it is cut, either way. */}
            <Tip content={row.name} when={(trigger) => cut.text !== row.name || isTextCut(trigger)}>
              <span className="ib-sp-p" dir="auto">
                <Marked text={cut.text} marks={cut.marks} />
              </span>
            </Tip>
            {/* A file's document indexes its name and its folder; a guide's, its title: neither marks the chip or the project. */}
            <MetaLine
              chip={chip}
              chipTerms={NO_TERMS}
              lead={<bdi dir="auto">{row.type === 'guide' ? 'Guided review' : row.folder ? <Words text={`${row.folder}/`} terms={terms} /> : 'File'}</bdi>}
              project={projectName}
              projectMarks={NO_MARKS}
            />
          </span>
          <span className="ib-sp-chip ib-sp-kind">{row.kind}</span>
          {row.archived && <span className="ib-sp-chip">Archived</span>}
        </>
      );
    }
    case 'project':
      return (
        <span className="ib-sp-rs">
          {/* The folder is the project's whole identity; the name may be cut. */}
          <Tip content={<ProjectTipText name={row.name} root={row.root} />}>
            <span className="ib-sp-p" dir="auto">
              <Marked text={row.name} marks={row.name_marks} />
            </span>
          </Tip>
          {/* The name's tooltip names the whole folder. */}
          <Secondary
            parts={[
              'Project',
              <bdi>
                <Words text={row.root} terms={terms} />
              </bdi>,
            ]}
          />
        </span>
      );
  }
}

/**
 * "Searched only plannotator. Search everywhere": what a filtered search left
 * out, and the one click that searches everything (every chip back to its
 * start). Under "No matches", and under the results while a filter is set, so
 * a search that started inside a project never misses a thread without saying so.
 */
function SearchedOnly({ scope, onEverywhere }: { scope: readonly string[]; onEverywhere: () => void }) {
  return (
    <>
      Searched only{' '}
      {scope.map((s, i) => (
        <span key={i}>
          {i > 0 && ', '}
          <bdi>{s}</bdi>
        </span>
      ))}
      .{' '}
      <button type="button" data-clear-filters="" onClick={onEverywhere}>
        Search everywhere
      </button>
    </>
  );
}

/** A mouse press in the list keeps focus in the input; the click still runs. */
function keepInputFocus(event: ReactMouseEvent): void {
  event.preventDefault();
}

export default function SearchPalette(props: SearchPaletteProps) {
  const { open, phone, currentProject, projects, projectLabels, onClose, onOpenResult, actions, onAction, shapes } = props;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** An IME composition is under way in the input (its Escape is not the palette's). */
  const composing = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const filtersRef = useRef<HTMLDivElement>(null);
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const listId = `ib-sp-list-${uid}`;
  const optionId = (i: number) => `ib-sp-o-${uid}-${i}`;

  const [q, setQ] = useState('');
  const [filters, setFilters] = useState<SearchFilters>(NO_FILTERS);
  const [answered, setAnswered] = useState<Answered | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState<Partial<Record<InboxSearchGroupId, InboxSearchRow[]>>>({});
  const [hl, setHl] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ kind: ChipKind; hl: number } | null>(null);
  /** The Type chip's group, or null for All types. Read by `run` through the ref, so a pick is sent at once. */
  const [type, setTypeState] = useState<InboxSearchGroupId | null>(null);
  const typeRef = useRef<InboxSearchGroupId | null>(null);
  const setType = (next: InboxSearchGroupId | null) => {
    typeRef.current = next;
    setTypeState(next);
  };
  const [live, setLive] = useState('');
  /** Best match or Newest: this browser's pick, kept across opens (searchSort.ts). */
  const sort = useSearchSort();
  const [fades, setFades] = useState({ top: false, bottom: false });

  const names = useMemo(() => projectLabels ?? projectNames(projects), [projectLabels, projects]);
  const projectName = useCallback((id: string) => names.get(id) ?? id, [names]);
  const projectNameRef = useRef(projectName);
  projectNameRef.current = projectName;

  // ── the dialog ──
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') {
        try {
          dialog.showModal();
        } catch {
          dialog.setAttribute('open', '');
        }
      } else dialog.setAttribute('open', '');
      inputRef.current?.focus();
    } else if (!open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
  }, [open]);

  // Every open starts from an empty query, All types and no filter: everywhere, even with a project open in the list
  // (the owner, 2026-11-06; that project's results come first on ties, `current`). The person picks a project to narrow.
  useLayoutEffect(() => {
    if (!open) return;
    setQ('');
    setFilters(NO_FILTERS);
    setType(null);
    setExpanded({});
    setMenu(null);
    setError(false);
    setHl(null);
    setAnswered(null);
    setLive('');
  }, [open]);

  // ── requests ──
  const requestSeq = useRef(0);
  const inflight = useRef<AbortController | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Enter pressed while a newer query was on its way: open its first row once it lands. */
  const openWhenSettled = useRef(false);

  const clearTimers = () => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    if (retryTimer.current) clearTimeout(retryTimer.current);
    debounceTimer.current = null;
    retryTimer.current = null;
  };

  const run = useCallback(
    (query: string, nextFilters: SearchFilters, nextType: InboxSearchGroupId | null = typeRef.current) => {
      clearTimers();
      inflight.current?.abort();
      const controller = new AbortController();
      inflight.current = controller;
      const seq = ++requestSeq.current;
      const nextSort = readSearchSort();
      const key = JSON.stringify([query.trim(), nextFilters, nextType, nextSort]);
      // A picked type asks for its group alone, the first page ("Show all"'s request); with no words, the request is today's.
      const one = nextType && query.trim() ? { group: nextType, limit: SEARCH_PAGE } : {};
      setPending(true);
      setError(false);
      searchInbox({ q: query, ...nextFilters, current: currentProject, sort: nextSort, ...one }, controller.signal)
        .then((model) => {
          if (seq !== requestSeq.current) return;
          if (model.indexing) {
            // Skeletons and the indexing line until the index is built; ask again.
            setAnswered({ key, q: query.trim(), model, filters: nextFilters, type: nextType, sort: nextSort });
            retryTimer.current = setTimeout(() => run(query, nextFilters, nextType), SEARCH_INDEXING_RETRY_MS);
            return;
          }
          setPending(false);
          setExpanded({});
          setAnswered({ key, q: query.trim(), model, filters: nextFilters, type: nextType, sort: nextSort });
          const said = nextType ? typeCountWords(model, query, nextType) : countWords(model, query, filtersSet(nextFilters));
          // Found inside a filter: the count says so, as the line under the list does ("2 results in 2 groups. Searched only plannotator").
          const only = said && query.trim() && filtersSet(nextFilters) && !said.startsWith('No ') ? scopeWords(nextFilters, projectNameRef.current, nextType).join(', ') : '';
          setLive(only ? `${said}. Searched only ${only}` : said);
        })
        .catch((cause) => {
          if (seq !== requestSeq.current || (cause instanceof DOMException && cause.name === 'AbortError')) return;
          setPending(false);
          setError(true);
          setLive('Search is not answering.');
          openWhenSettled.current = false;
        });
    },
    [currentProject],
  );

  // The first answer of an open: at once.
  useEffect(() => {
    if (!open) return;
    run('', NO_FILTERS);
    return () => {
      clearTimers();
      inflight.current?.abort();
      requestSeq.current += 1;
    };
    // run at the open only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onInput = (value: string) => {
    setQ(value);
    setPending(true);
    clearTimers();
    debounceTimer.current = setTimeout(() => run(value, filters), SEARCH_DEBOUNCE_MS);
  };

  const changeFilters = (next: SearchFilters) => {
    setFilters(next);
    run(q, next);
  };
  /** Best match or Newest: remembered for this browser, and the words asked again in that order. */
  const changeSort = (next: InboxSearchSort) => {
    if (next === sort) return;
    setSearchSort(next);
    run(q, filters);
  };
  /** "Clear filters" and "Search everywhere": every chip back to its start (All types too), focus back in the input. */
  const clearFilters = () => {
    setType(null);
    changeFilters(NO_FILTERS);
    inputRef.current?.focus();
  };

  // ── options ──
  const groups: SearchGroupView[] = useMemo(() => {
    if (!answered) return [];
    // A picked type with no words: nothing yet (the recent view is not that type).
    if (answered.type && !answered.q) return [];
    // While the index builds there are no results yet, but the actions still show.
    const found = answered.model.indexing ? [] : searchGroups(answered.model, expanded);
    // A picked type lists its group alone, without Actions.
    if (answered.type) return found;
    // Shape's boards the words find: their own group, under the results.
    const shapeList = shapes && answered.q.trim() ? shapes(answered.q) : [];
    const withShapes = shapeList.length ? [...found, { id: 'shapes' as const, heading: 'Shape', total: null, options: shapeList.map((shape) => ({ kind: 'shape' as const, shape })) }] : found;
    const actionList = actions ? actions(answered.q) : [];
    if (actionList.length === 0) return withShapes;
    const group: SearchGroupView = { id: 'actions', heading: 'Actions', total: null, options: actionList.map((action) => ({ kind: 'action' as const, action })) };
    // Above everything (Recent searches included) with no words, when nothing
    // matched, or when the words name an action; below real results otherwise.
    const first = !answered.q.trim() || withShapes.length === 0 || namesActionWord(answered.q);
    return first ? [group, ...withShapes] : [...withShapes, group];
  }, [answered, expanded, actions, shapes]);
  const options = useMemo(() => groups.flatMap((g) => g.options), [groups]);
  const optionsKey = answered?.key ?? '';
  // The highlight snaps to the first row when the rows change (a new answer), never while arrowing.
  useLayoutEffect(() => {
    setHl(options.length > 0 ? 0 : null);
    // Only a new answer resets it; expanding a group keeps the row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionsKey]);
  useEffect(() => {
    if (!openWhenSettled.current || pending || !answered || answered.model.indexing) return;
    openWhenSettled.current = false;
    if (options.length > 0) activate(0, false);
    // activate reads the settled answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, answered]);

  useLayoutEffect(() => {
    if (hl === null) return;
    document.getElementById(optionId(hl))?.scrollIntoView?.({ block: 'nearest' });
    // optionId is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hl]);

  // The list's top and bottom fades: only where it overflows, re-measured after every render and on resize.
  const measure = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const top = list.scrollTop > 1;
    const bottom = list.scrollTop + list.clientHeight < list.scrollHeight - 1;
    setFades((f) => (f.top === top && f.bottom === bottom ? f : { top, bottom }));
  }, []);
  useLayoutEffect(measure);
  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  const expand = async (option: Extract<SearchOption, { kind: 'more' }>, index: number) => {
    if (!answered) return;
    // Focus stays in the input, so the arrows go on from the expanded group.
    inputRef.current?.focus();
    // A picked type's answer already holds its first page: "Show 50 more" goes on from there.
    const already = expanded[option.group] ?? (answered.type === option.group ? (answered.model.groups?.[option.group] ?? null) : null);
    const offset = already ? already.length : 0;
    try {
      const model = await searchInbox({ q: answered.q, ...filters, current: currentProject, sort: answered.sort, group: option.group, offset, limit: SEARCH_PAGE });
      // A message that came in since the last page moves the next one down: a row already shown is not shown twice.
      const shown = new Set((already ?? []).map((row) => `${row.type}-${row.id}`));
      const more = (model.groups?.[option.group] ?? []).filter((row) => !shown.has(`${row.type}-${row.id}`));
      setExpanded((current) => ({ ...current, [option.group]: [...(already ?? []), ...more] }));
      setHl(index);
    } catch {
      setError(true);
    }
  };

  const close = (reason: 'dismissed' | 'opened') => {
    setMenu(null);
    clearTimers();
    inflight.current?.abort();
    onClose(reason);
  };

  function activate(index: number, newTab: boolean) {
    const option = options[index];
    if (!option || !answered) return;
    if (option.kind === 'more') {
      void expand(option, index);
      return;
    }
    if (option.kind === 'action') {
      close('opened');
      onAction?.(option.action);
      return;
    }
    if (option.kind === 'shape') {
      if (newTab) {
        window.open(`${window.location.pathname}${window.location.search}${option.shape.hash}`, '_blank', 'noopener');
        return;
      }
      close('opened');
      onOpenResult(option.shape.hash, null);
      return;
    }
    if (option.kind === 'recent-q') {
      setQ(option.q);
      run(option.q, filters);
      inputRef.current?.focus();
      return;
    }
    const target = resultTarget(option.row, answered.model.terms ?? []);
    if (newTab) {
      // A new tab opens the same place; this palette stays open (as Workspaces').
      window.open(`${window.location.pathname}${window.location.search}${target.hash}`, '_blank', 'noopener');
      return;
    }
    // Recent searches: written only when a result is opened, and only for words.
    if (answered.q && (answered.model.terms ?? []).length > 0) void saveRecentSearch({ q: answered.q }).catch(() => {});
    close('opened');
    onOpenResult(target.hash, target.land);
  }

  const clearRecent = async () => {
    try {
      await saveRecentSearch({ clear: true });
    } catch {
      return;
    }
    setAnswered((current) => (current ? { ...current, model: { ...current.model, recent_searches: [] } } : current));
    inputRef.current?.focus();
  };

  // ── keys ──
  const onInputKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // While an IME composes, its keys are its own (candidate lists use the arrows, Escape cancels the composition).
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (options.length === 0) return;
      const down = event.key === 'ArrowDown';
      setHl((current) => (current === null ? (down ? 0 : options.length - 1) : (current + (down ? 1 : -1) + options.length) % options.length));
      return;
    }
    if (event.key === 'Enter') {
      // (An IME's Enter, which commits text, returned above: it never opens a result.)
      event.preventDefault();
      const newTab = event.metaKey || event.ctrlKey;
      if (debounceTimer.current || pending) {
        // A newer query is still settling: open its first row once it lands.
        if (debounceTimer.current) run(q, filters);
        if (!newTab) openWhenSettled.current = true;
        return;
      }
      if (hl !== null) activate(hl, newTab);
    }
  };

  const onDialogKey = (event: ReactKeyboardEvent<HTMLDialogElement>) => {
    // The open palette's keys are its own: nothing reaches the window's shortcuts behind it.
    event.stopPropagation();
    if (event.key === 'Escape') {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      if (menu) {
        const kind = menu.kind;
        setMenu(null);
        filtersRef.current?.querySelector<HTMLElement>(`[data-chip="${kind}"]`)?.focus();
      } else close('dismissed');
      return;
    }
    if (event.key === 'Tab') {
      if (menu) setMenu(null);
      // A radio group is one stop (the chosen radio), as a browser's own Tab order has it; its arrows choose.
      const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(
        (el) => el.getClientRects().length > 0 && !(el instanceof HTMLInputElement && el.type === 'radio' && !el.checked),
      );
      if (items.length === 0) return;
      const at = items.indexOf(document.activeElement as HTMLElement);
      event.preventDefault();
      items[(at + (event.shiftKey ? -1 : 1) + items.length) % items.length]!.focus();
    }
  };

  // ── filter chips and their menus ──
  // A type's count, from the answer's totals, once there are words.
  const typeCount = (id: InboxSearchGroupId): number | null => (answered && answered.q && !answered.model.indexing && answered.model.totals ? answered.model.totals[id] : null);
  const menuOptions = (kind: ChipKind): { value: string | null; label: string; count?: number | null }[] =>
    kind === 'type'
      ? [{ value: null, label: 'All types' }, ...INBOX_SEARCH_GROUPS.map((id) => ({ value: id, label: GROUP_LABELS[id].heading, count: typeCount(id) }))]
      : kind === 'project'
        ? [{ value: null, label: 'All projects' }, ...projects.map((p) => ({ value: p.id, label: projectName(p.id) }))]
        : kind === 'status'
          ? STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))
          : FROM_OPTIONS.map((o) => ({ value: o.value, label: o.label }));

  const chipValue = (kind: ChipKind): string | null => (kind === 'type' ? type : filters[kind]);
  /** Set one chip (null: back to its start) and ask again. */
  const setChip = (kind: ChipKind, value: string | null) => {
    if (kind === 'type') {
      const next = value as InboxSearchGroupId | null;
      setType(next);
      run(q, filters, next);
    } else changeFilters({ ...filters, [kind]: value } as SearchFilters);
  };
  const openMenu = (kind: ChipKind) => {
    if (menu?.kind === kind) {
      setMenu(null);
      return;
    }
    const at = menuOptions(kind).findIndex((o) => o.value === chipValue(kind));
    setMenu({ kind, hl: Math.max(0, at) });
  };
  const pick = (kind: ChipKind, value: string | null) => {
    setMenu(null);
    setChip(kind, value);
    requestAnimationFrame(() => filtersRef.current?.querySelector<HTMLElement>(`[data-chip="${kind}"]`)?.focus());
  };
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]')[menu.hl]?.focus();
  }, [menu]);
  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!menu) return;
    const items = menuOptions(menu.kind);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setMenu({ ...menu, hl: (menu.hl + step + items.length) % items.length });
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setMenu({ ...menu, hl: event.key === 'Home' ? 0 : items.length - 1 });
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      pick(menu.kind, items[menu.hl]!.value);
    }
  };
  // A click outside an open menu closes it.
  useEffect(() => {
    if (!menu) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target && !target.closest('.ib-sp-menu') && !target.closest('[data-chip]')) setMenu(null);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [menu]);

  const chip = (kind: ChipKind) => {
    const set = chipValue(kind) !== null;
    const label = kind === 'type' ? (type ? GROUP_LABELS[type].heading : 'All types') : chipText(kind, filters, projectName);
    const button = (
      <Tip content={label} when={(trigger) => isTextCut(trigger.querySelector('.ib-sp-fl'))}>
        <button
          type="button"
          className="ib-sp-fchip"
          data-chip={kind}
          data-set={set ? '' : undefined}
          aria-haspopup="menu"
          aria-expanded={menu?.kind === kind}
          onClick={() => openMenu(kind)}
        >
          <span className="ib-sp-fl" dir="auto">
            {label}
          </span>
          {/* A set filter shows its × instead (approval "inbox-search-calm"); a click still opens its menu. */}
          {!set && <Icon name="chevD" />}
        </button>
      </Tip>
    );
    if (!set) return <span key={kind} className="ib-sp-fcell" data-cell={kind}>{button}</span>;
    return (
      <span key={kind} className="ib-sp-fcell ib-sp-fwrap" data-cell={kind}>
        {button}
        <button type="button" className="ib-sp-fx" data-unset={kind} aria-label={`Clear the ${kind} filter`} onClick={() => {
          setChip(kind, null);
          requestAnimationFrame(() => filtersRef.current?.querySelector<HTMLElement>(`[data-chip="${kind}"]`)?.focus());
        }}>
          <Icon name="x" />
        </button>
      </span>
    );
  };

  const menuEl = (() => {
    if (!menu) return null;
    const items = menuOptions(menu.kind);
    const chipEl = filtersRef.current?.querySelector<HTMLElement>(`[data-chip="${menu.kind}"]`);
    // Under the chip's own cell (a phone's menu is a sheet at the bottom instead).
    const cell = chipEl?.closest<HTMLElement>('.ib-sp-fcell');
    const left = cell?.offsetLeft ?? 10;
    const top = cell ? cell.offsetTop + cell.offsetHeight + 6 : undefined;
    const label = menu.kind === 'type' ? 'Type' : menu.kind === 'project' ? 'Project' : menu.kind === 'status' ? 'Status' : 'From';
    return (
      <div ref={menuRef} className="ib-sp-menu" role="menu" aria-label={label} style={phone ? undefined : { left, top }} onKeyDown={onMenuKey}>
        {items.map((item, i) => {
          const checked = chipValue(menu.kind) === item.value;
          return (
            <div
              key={item.value ?? 'any'}
              className="ib-sp-mi"
              role="menuitemradio"
              tabIndex={-1}
              aria-checked={checked}
              data-hl={menu.hl === i ? '' : undefined}
              onPointerMove={() => menu.hl !== i && setMenu({ ...menu, hl: i })}
              onClick={() => pick(menu.kind, item.value)}
            >
              <span className="ib-sp-mck">{checked && <Icon name="check" />}</span>
              <Tip content={item.label} cut>
                <span className="ib-sp-ml" dir="auto">
                  {item.label}
                </span>
              </Tip>
              {item.count != null && <span className="ib-sp-mn">{formatCount(item.count)}</span>}
            </div>
          );
        })}
      </div>
    );
  })();

  // ── body ──
  const filtered = filtersSet(filters);
  const indexing = answered?.model.indexing === true;
  let index = -1;
  const body = (() => {
    if (error) {
      return (
        <div className="ib-sp-empty">
          <span>Search isn&rsquo;t answering.</span>
          <span className="ib-sp-e2">
            <button type="button" data-search-retry="" onClick={() => run(q, filters)}>
              Try again
            </button>
          </span>
        </div>
      );
    }
    if (!answered || indexing) {
      // Nothing settled yet: skeletons (and, while the index builds, the quiet line). Never a spinner in the input.
      if (!answered && !pending) return null;
      return (
        <>
          {indexing && renderGroups()}
          <div className="ib-sp-group">
            <div className="ib-sp-gh">Threads</div>
            <div className="ib-sp-skel"><i style={{ width: '62%' }} /><i /></div>
            <div className="ib-sp-skel"><i style={{ width: '48%' }} /><i /></div>
          </div>
          <div className="ib-sp-group">
            <div className="ib-sp-gh">Messages</div>
            {indexing && <div className="ib-sp-indexing" data-search-indexing="">Indexing {answered!.model.threads.toLocaleString('en-US')} threads&hellip;</div>}
            <div className="ib-sp-skel"><i style={{ width: '78%' }} /><i /></div>
            <div className="ib-sp-skel"><i style={{ width: '70%' }} /><i /></div>
            <div className="ib-sp-skel"><i style={{ width: '56%' }} /><i /></div>
          </div>
        </>
      );
    }
    if (options.length === 0) {
      if (answered.type && !answered.q) return <div className="ib-sp-empty ib-sp-quiet" data-search-type-empty="">Type to search {GROUP_LABELS[answered.type].noun}.</div>;
      if (!answered.q && !filtered) return <div className="ib-sp-empty ib-sp-quiet">Type to search threads, messages and files.</div>;
      const scope = scopeWords(answered.filters, projectName, answered.type);
      return (
        <div className="ib-sp-empty" data-search-none="">
          <span>
            {answered.q ? (
              <>
                No matches for &ldquo;<bdi>{answered.q}</bdi>&rdquo;
              </>
            ) : (
              'No threads match these filters'
            )}
          </span>
          {scope.length > 0 && (
            <span className="ib-sp-e2">
              <SearchedOnly scope={scope} onEverywhere={clearFilters} />
            </span>
          )}
        </div>
      );
    }
    return renderGroups();
    function renderGroups() {
    return groups.map((group) => {
      const headingId = `ib-sp-g-${uid}-${group.id}`;
      return (
        <div key={group.id} className="ib-sp-group" role="group" aria-labelledby={headingId} data-search-group={group.id}>
          <div className="ib-sp-gh" id={headingId} onMouseDown={keepInputFocus}>
            {group.heading}
            {group.total !== null && <span className="ib-sp-gn">{group.total.toLocaleString('en-US')}</span>}
            {group.id === 'recent-searches' && (
              <button type="button" className="ib-sp-gclear" data-clear-recent="" onClick={() => void clearRecent()}>
                Clear
              </button>
            )}
          </div>
          {group.options.map((option) => {
            index += 1;
            const i = index;
            const selected = hl === i;
            const common = {
              id: optionId(i),
              role: 'option' as const,
              'aria-selected': selected,
              'data-option': i,
              onPointerMove: () => hl !== i && setHl(i),
              onMouseDown: keepInputFocus,
              onClick: (event: ReactMouseEvent) => activate(i, event.metaKey || event.ctrlKey),
            };
            if (option.kind === 'recent-q') {
              return (
                <div key={`q-${option.q}`} className="ib-sp-row" {...common} data-recent-search="">
                  <span className="ib-sp-mark" aria-hidden="true">
                    <Icon name="clock" className="ib-sp-mk" />
                  </span>
                  <span className="ib-sp-rs">
                    <Tip content={option.q} cut>
                      <span className="ib-sp-p" dir="auto">
                        {option.q}
                      </span>
                    </Tip>
                  </span>
                </div>
              );
            }
            if (option.kind === 'action') {
              const action = option.action;
              return (
                <div key={action.kind !== 'message' ? `action-${action.kind}` : `action-${action.target.session}`} className="ib-sp-row" {...common} data-compose-action={action.kind}>
                  <span className="ib-sp-mark" aria-hidden="true">
                    {action.kind !== 'message' ? <Icon name={action.kind === 'new' ? 'compose' : 'code'} className="ib-sp-mk" /> : <HostMark host={action.target.host} agent={action.target.session} />}
                  </span>
                  <span className="ib-sp-rs">
                    <span className="ib-sp-p">{actionLabel(action)}</span>
                    <span className="ib-sp-s">
                      {action.kind === 'new' ? 'Start a thread with a live agent' : action.kind === 'review' ? 'Local changes or a pull request' : `${startedLine(action.target)} · ${busyWord(action.target).toLowerCase()}`}
                    </span>
                  </span>
                </div>
              );
            }
            if (option.kind === 'shape') {
              const shape = option.shape;
              return (
                <div key={`shape-${shape.id}`} className="ib-sp-row" {...common} data-result="shape" data-result-id={shape.id}>
                  <span className="ib-sp-shape-prev" aria-hidden="true">
                    <ShapeThumb picture={shape.picture} refs={shape.refs} resolveSrc={(src) => inboxApi.shapeFileUrl(shape.id, src)} />
                  </span>
                  <span className="ib-sp-rs">
                    <span className="ib-sp-p">{shape.title}</span>
                  </span>
                  <span className="ib-sp-time ib-sp-shape-meta">
                    {shape.project} · {shape.meta}
                  </span>
                </div>
              );
            }
            if (option.kind === 'more') {
              return (
                <div key={`more-${option.group}`} className="ib-sp-row ib-sp-more" {...common} data-show-more={option.group}>
                  <span className="ib-sp-mark" aria-hidden="true">
                    <Icon name="chevD" className="ib-sp-mk" />
                  </span>
                  <span className="ib-sp-rs">
                    <span className="ib-sp-p">{moreLabel(option)}</span>
                  </span>
                </div>
              );
            }
            const row = option.row;
            return (
              <div key={`${row.type}-${row.id}`} className="ib-sp-row" {...common} data-result={row.type} data-result-id={row.id}>
                <ResultContent row={row} phone={phone} projectName={names.get(row.project.id) ?? row.project.name} terms={answered?.model.terms ?? NO_TERMS} />
              </div>
            );
          })}
        </div>
      );
    });
    }
  })();

  const anyFilter = filtered;
  // Results found inside a filter (a project the person picked, say): say what was left out, under the list.
  // The filters the shown answer was asked with: a chip changed since keeps the line true until its own answer lands.
  const scopeShown = Boolean(answered && answered.q && !indexing && !error && filtersSet(answered.filters) && options.length > 0);
  const resultScope = scopeShown ? scopeWords(answered!.filters, projectName, answered!.type) : [];
  // The order only means something for words: the recent view and filters alone keep their own order.
  const sortSwitch = q.trim() ? <SortSwitch sort={sort} onChange={changeSort} name={`ib-sp-sort-${uid}`} /> : null;
  return (
    <dialog
      ref={dialogRef}
      className="ib-sp"
      role="dialog"
      aria-modal="true"
      aria-label="Search the Inbox"
      data-search-palette=""
      data-phone={phone ? '' : undefined}
      onKeyDown={onDialogKey}
      onCancel={(event) => {
        // Escape on a control is handled above (a menu first); this is Escape with focus nowhere in particular.
        event.preventDefault();
        // An Escape that cancelled an IME composition closes nothing.
        if (composing.current) return;
        if (menu) setMenu(null);
        else close('dismissed');
      }}
      onClick={(event) => {
        // A click on the backdrop (outside the panel's box) closes it.
        const dialog = dialogRef.current;
        if (!dialog || event.target !== dialog) return;
        const r = dialog.getBoundingClientRect();
        if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close('dismissed');
      }}
    >
      <div className="ib-sp-inrow">
        <Icon name="search" />
        <input
          ref={inputRef}
          className="ib-sp-input"
          type="text"
          role="combobox"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={hl !== null && options[hl] ? optionId(hl) : undefined}
          placeholder="Search threads, messages and files"
          aria-label="Search threads, messages and files"
          dir="auto"
          maxLength={400}
          value={q}
          onChange={(event) => onInput(event.target.value)}
          onKeyDown={onInputKey}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            // After the key that ended it (an Escape's cancel event comes first).
            setTimeout(() => {
              composing.current = false;
            }, 0);
          }}
        />
        {/* The order (approval "inbox-search-calm", filter row "Up"): on a desktop at the search box's end, once there
            are words, so the filter row below is the filters alone and fits one line. Tab: the box, the order, the filters. */}
        {!phone && sortSwitch}
        <button type="button" className="ib-sp-cancel" data-search-cancel="" onClick={() => close('dismissed')}>
          Cancel
        </button>
      </div>
      {/* The filters and Clear filters on one line. A phone's filters scroll sideways, the order pinned at the line's end. */}
      <div className="ib-sp-fbar" data-search-filter-bar="">
        <div className="ib-sp-filters" ref={filtersRef}>
          {chip('type')}
          {chip('project')}
          {chip('status')}
          {chip('from')}
          {anyFilter && (
            <span className="ib-sp-end">
              <button type="button" className="ib-sp-clear" data-clear-filters="" onClick={clearFilters}>
                Clear filters
              </button>
            </span>
          )}
          {menuEl}
        </div>
        {phone && sortSwitch && <span className="ib-sp-pin">{sortSwitch}</span>}
      </div>
      <div className="ib-sp-frame">
        <div className="ib-sp-fade ib-sp-top" data-on={fades.top ? '' : undefined} />
        <div
          ref={listRef}
          id={listId}
          className="ib-sp-list"
          role="listbox"
          aria-label="Search results"
          data-dim={pending && answered && !indexing ? '' : undefined}
          onScroll={measure}
        >
          {body}
        </div>
        <div className="ib-sp-fade ib-sp-bot" data-on={fades.bottom ? '' : undefined} />
      </div>
      {resultScope.length > 0 && (
        <div className="ib-sp-scope" data-search-scope="" onMouseDown={keepInputFocus}>
          <SearchedOnly scope={resultScope} onEverywhere={clearFilters} />
        </div>
      )}
      {!phone && <KeyFooter />}
      <div className="ib-sr" role="status" aria-live="polite" data-search-live="">
        {live}
      </div>
    </dialog>
  );
}

