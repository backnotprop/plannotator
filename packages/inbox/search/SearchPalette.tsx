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
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { middleCutInboxName, type InboxSearchGroupId, type InboxSearchRow } from '@plannotator/core/inbox-search';
import { saveRecentSearch, searchInbox, type SearchModel } from '../api';

import { HostMark, Icon } from '../icons';
import { isTextCut, ProjectTipText, Tip } from '../components/Tip';
import { actionLabel, busyWord, namesActionWord, startedLine, type ComposeAction } from '../compose/model';
import {
  FROM_OPTIONS,
  NO_FILTERS,
  SEARCH_PAGE,
  STATUS_OPTIONS,
  chipText,
  countWords,
  filtersSet,
  markedRuns,
  moreLabel,
  projectNames,
  resultTarget,
  rowThreadChip,
  scopeWords,
  searchTime,
  searchGroups,
  sectionLabel,
  type SearchFilters,
  type SearchGroupView,
  type SearchOption,
  type RowThreadChip,
} from './model';

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
  /** The project open in the list: a tie boost, and the Project chip's starting value (the person can clear it). */
  currentProject: string | null;
  /** The projects for the Project chip, with their names as the person reads them. */
  projects: readonly { id: string; name: string; root: string }[];
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
}

type FilterKind = keyof SearchFilters;

interface Answered {
  /** The query and filters this answer is for. */
  key: string;
  q: string;
  model: SearchModel;
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

/** A composed secondary line: each part apart, user-written parts in <bdi> that truncate on their own. */
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
 * The thread chip, the list's own (`.ib-key` / `.ib-keyt`): the thread's name
 * in the list's monospace face, or, for a thread with no name, its subject in
 * the row's face. Its tooltip and accessible words carry the whole thread:
 * "Thread nightly-deploy: Investigate why…" (always for a named thread, whose
 * subject is not on screen; a subject chip only while it is cut).
 */
function ThreadChip({ chip }: { chip: RowThreadChip }) {
  const whole = chip.kind === 'name' && chip.subject ? `${chip.text}: ${chip.subject}` : chip.text;
  const named = chip.kind === 'name' && Boolean(chip.subject);
  return (
    <Tip content={`Thread: ${whole}`} when={named ? undefined : (trigger) => isTextCut(trigger.querySelector('.ib-keyt'))}>
      <span className={`ib-key ib-sp-key${chip.kind === 'subject' ? ' ib-sp-key-subj' : ''}`} data-result-thread={chip.kind}>
        <span className="ib-sr">Thread: </span>
        <bdi className="ib-keyt" dir="auto">
          {chip.text}
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
 * by "·" (", " for a screen reader). One line: the project and the chip give way
 * together; the lead, the section and the time keep their place. Each
 * user-written part is a `<bdi dir="auto">` cut at its own end, its whole
 * text in the DOM and in a tooltip while it is cut.
 */
function MetaLine({ chip, lead, project, section, at }: { chip: RowThreadChip | null; lead?: ReactNode; project: string; section?: string | null; at?: string | null }) {
  const parts: { node: ReactNode; className: string }[] = [];
  if (lead) parts.push({ node: lead, className: 'ib-sp-lead' });
  parts.push({
    node: (
      <Tip content={project} when={(trigger) => isTextCut(trigger.closest('.ib-sp-pj'))}>
        <bdi dir="auto">{project}</bdi>
      </Tip>
    ),
    className: 'ib-sp-pj',
  });
  if (section) parts.push({ node: section, className: 'ib-sp-sec' });
  if (at) parts.push({ node: at, className: 'ib-sp-at' });
  return (
    <span className="ib-sp-s ib-sp-tl">
      {chip && <ThreadChip chip={chip} />}
      {parts.map((part, i) => (
        <span key={i} className={part.className}>
          {i > 0 && (
            <>
              <span className="ib-sp-sep" aria-hidden="true">
                ·
              </span>
              <span className="ib-sr">, </span>
            </>
          )}
          {part.node}
        </span>
      ))}
    </span>
  );
}

function RowBody({ row, phone, projectName }: { row: InboxSearchRow; phone: boolean; projectName: string }) {
  const chip = rowThreadChip(row);
  switch (row.type) {
    case 'thread': {
      const label = row.archived || row.section === 'stopped' ? null : sectionLabel(row.section);
      return (
        <>
          <span className="ib-sp-rs">
            <Tip content={row.title} cut>
              <span className="ib-sp-p" dir="auto">
                <Marked text={row.title} marks={row.title_marks} />
              </span>
            </Tip>
            <MetaLine chip={chip} project={projectName} section={label} at={searchTime(row.at)} />
          </span>
          {row.archived ? <span className="ib-sp-chip">Archived</span> : row.section === 'stopped' ? <span className="ib-sp-chip ib-sp-warn">Stopped</span> : null}
        </>
      );
    }
    case 'message':
      return (
        <>
          <span className="ib-sp-rs">
            <Tip content={row.snippet.text} cut>
              <span className="ib-sp-p ib-sp-snip" dir="auto">
                <Marked text={row.snippet.text} marks={row.snippet.marks} />
              </span>
            </Tip>
            <MetaLine chip={chip} lead={row.author.kind === 'me' ? 'You' : <bdi dir="auto">{row.author.name}</bdi>} project={projectName} at={searchTime(row.at)} />
          </span>
          {/* An action item (an Inbox `:::action`, key `a-…`) reads "Action item", not "Question". */}
          {row.question && <span className="ib-sp-chip">{row.question.key.startsWith('a-') ? 'Action item' : 'Question'}</span>}
          {row.question?.replaced && <span className="ib-sp-chip">Replaced</span>}
          {row.archived && <span className="ib-sp-chip">Archived</span>}
        </>
      );
    case 'file':
    case 'guide': {
      const cut = middleCutInboxName(row.name, phone ? 30 : 46, row.name_marks);
      return (
        <>
          <span className="ib-sp-rs">
            {/* The name is cut in its middle here (JS): the whole name whenever it is cut, either way. */}
            <Tip content={row.name} when={(trigger) => cut.text !== row.name || isTextCut(trigger)}>
              <span className="ib-sp-p" dir="auto">
                <Marked text={cut.text} marks={cut.marks} />
              </span>
            </Tip>
            <MetaLine chip={chip} lead={<bdi dir="auto">{row.type === 'guide' ? 'Guided review' : row.folder ? `${row.folder}/` : 'File'}</bdi>} project={projectName} />
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
          <Secondary parts={['Project', <bdi>{row.root}</bdi>]} />
        </span>
      );
  }
}

/** A mouse press in the list keeps focus in the input; the click still runs. */
function keepInputFocus(event: ReactMouseEvent): void {
  event.preventDefault();
}

export default function SearchPalette(props: SearchPaletteProps) {
  const { open, phone, currentProject, projects, onClose, onOpenResult, actions, onAction } = props;
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
  const [menu, setMenu] = useState<{ kind: FilterKind; hl: number } | null>(null);
  const [live, setLive] = useState('');
  const [fades, setFades] = useState({ top: false, bottom: false });

  const names = useMemo(() => projectNames(projects), [projects]);
  const projectName = useCallback((id: string) => names.get(id) ?? id, [names]);

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

  // Every open starts from an empty query, with the Project chip on the project open in the list.
  const startFilters = useMemo<SearchFilters>(() => ({ ...NO_FILTERS, project: currentProject }), [currentProject]);
  useLayoutEffect(() => {
    if (!open) return;
    setQ('');
    setFilters(startFilters);
    setExpanded({});
    setMenu(null);
    setError(false);
    setHl(null);
    setAnswered(null);
    setLive('');
    // startFilters is read at the open only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    (query: string, nextFilters: SearchFilters) => {
      clearTimers();
      inflight.current?.abort();
      const controller = new AbortController();
      inflight.current = controller;
      const seq = ++requestSeq.current;
      const key = JSON.stringify([query.trim(), nextFilters]);
      setPending(true);
      setError(false);
      searchInbox({ q: query, ...nextFilters, current: currentProject }, controller.signal)
        .then((model) => {
          if (seq !== requestSeq.current) return;
          if (model.indexing) {
            // Skeletons and the indexing line until the index is built; ask again.
            setAnswered({ key, q: query.trim(), model });
            retryTimer.current = setTimeout(() => run(query, nextFilters), SEARCH_INDEXING_RETRY_MS);
            return;
          }
          setPending(false);
          setExpanded({});
          setAnswered({ key, q: query.trim(), model });
          setLive(countWords(model, query, filtersSet(nextFilters)));
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
    run('', startFilters);
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
  /** "Clear filters" and "Search everywhere": every chip back to its start, focus back in the input. */
  const clearFilters = () => {
    changeFilters(NO_FILTERS);
    inputRef.current?.focus();
  };

  // ── options ──
  const groups: SearchGroupView[] = useMemo(() => {
    if (!answered) return [];
    // While the index builds there are no results yet, but the actions still show.
    const found = answered.model.indexing ? [] : searchGroups(answered.model, expanded);
    const actionList = actions ? actions(answered.q) : [];
    if (actionList.length === 0) return found;
    const group: SearchGroupView = { id: 'actions', heading: 'Actions', total: null, options: actionList.map((action) => ({ kind: 'action' as const, action })) };
    // Above everything (Recent searches included) with no words, when nothing
    // matched, or when the words name an action; below real results otherwise.
    const first = !answered.q.trim() || found.length === 0 || namesActionWord(answered.q);
    return first ? [group, ...found] : [...found, group];
  }, [answered, expanded, actions]);
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
    const already = expanded[option.group] ?? null;
    const offset = already ? already.length : 0;
    try {
      const model = await searchInbox({ q: answered.q, ...filters, current: currentProject, group: option.group, offset, limit: SEARCH_PAGE });
      const more = model.groups?.[option.group] ?? [];
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
      const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((el) => el.getClientRects().length > 0);
      if (items.length === 0) return;
      const at = items.indexOf(document.activeElement as HTMLElement);
      event.preventDefault();
      items[(at + (event.shiftKey ? -1 : 1) + items.length) % items.length]!.focus();
    }
  };

  // ── filter chips and their menus ──
  const menuOptions = (kind: FilterKind): { value: string | null; label: string }[] =>
    kind === 'project'
      ? [{ value: null, label: 'All projects' }, ...projects.map((p) => ({ value: p.id, label: projectName(p.id) }))]
      : kind === 'status'
        ? STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))
        : FROM_OPTIONS.map((o) => ({ value: o.value, label: o.label }));

  const openMenu = (kind: FilterKind) => {
    if (menu?.kind === kind) {
      setMenu(null);
      return;
    }
    const at = menuOptions(kind).findIndex((o) => o.value === filters[kind]);
    setMenu({ kind, hl: Math.max(0, at) });
  };
  const pick = (kind: FilterKind, value: string | null) => {
    setMenu(null);
    changeFilters({ ...filters, [kind]: value } as SearchFilters);
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

  const chip = (kind: FilterKind) => {
    const set = filters[kind] !== null;
    const label = chipText(kind, filters, projectName);
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
          <Icon name="chevD" />
        </button>
      </Tip>
    );
    if (!set) return <span key={kind} className="ib-sp-fcell">{button}</span>;
    return (
      <span key={kind} className="ib-sp-fcell ib-sp-fwrap">
        {button}
        <button type="button" className="ib-sp-fx" data-unset={kind} aria-label={`Clear the ${kind} filter`} onClick={() => {
          changeFilters({ ...filters, [kind]: null } as SearchFilters);
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
    const left = chipEl?.closest<HTMLElement>('.ib-sp-fcell')?.offsetLeft ?? 10;
    const label = menu.kind === 'project' ? 'Project' : menu.kind === 'status' ? 'Status' : 'From';
    return (
      <div ref={menuRef} className="ib-sp-menu" role="menu" aria-label={label} style={phone ? undefined : { left }} onKeyDown={onMenuKey}>
        {items.map((item, i) => {
          const checked = filters[menu.kind] === item.value;
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
      if (!answered.q && !filtered) return <div className="ib-sp-empty ib-sp-quiet">Type to search threads, messages and files.</div>;
      const scope = scopeWords(filters, projectName);
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
              Searched only{' '}
              {scope.map((s, i) => (
                <span key={i}>
                  {i > 0 && ', '}
                  <bdi>{s}</bdi>
                </span>
              ))}
              .{' '}
              <button type="button" data-clear-filters="" onClick={clearFilters}>
                Search everywhere
              </button>
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
                  <Icon name="clock" className="ib-sp-mk" />
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
                <div key={action.kind === 'new' ? 'action-new' : `action-${action.target.session}`} className="ib-sp-row" {...common} data-compose-action={action.kind}>
                  {action.kind === 'new' ? <Icon name="compose" className="ib-sp-mk" /> : <HostMark host={action.target.host} />}
                  <span className="ib-sp-rs">
                    <span className="ib-sp-p">{actionLabel(action)}</span>
                    <span className="ib-sp-s">
                      {action.kind === 'new' ? 'Start a thread with a live agent' : `${startedLine(action.target)} · ${busyWord(action.target).toLowerCase()}`}
                    </span>
                  </span>
                </div>
              );
            }
            if (option.kind === 'more') {
              return (
                <div key={`more-${option.group}`} className="ib-sp-row ib-sp-more" {...common} data-show-more={option.group}>
                  <Icon name="chevD" className="ib-sp-mk" />
                  <span className="ib-sp-rs">
                    <span className="ib-sp-p">{moreLabel(option)}</span>
                  </span>
                </div>
              );
            }
            const row = option.row;
            return (
              <div key={`${row.type}-${row.id}`} className="ib-sp-row" {...common} data-result={row.type} data-result-id={row.id}>
                <RowBody row={row} phone={phone} projectName={projectName(row.project.id)} />
              </div>
            );
          })}
        </div>
      );
    });
    }
  })();

  const anyFilter = filtered;
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
        <button type="button" className="ib-sp-cancel" data-search-cancel="" onClick={() => close('dismissed')}>
          Cancel
        </button>
      </div>
      <div className="ib-sp-filters" ref={filtersRef}>
        {chip('project')}
        {chip('status')}
        {chip('from')}
        {anyFilter && (
          <button type="button" className="ib-sp-clear" data-clear-filters="" onClick={clearFilters}>
            Clear filters
          </button>
        )}
        {menuEl}
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
      <div className="ib-sr" role="status" aria-live="polite" data-search-live="">
        {live}
      </div>
    </dialog>
  );
}

