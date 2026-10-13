import { useEffect, useId, useRef, useState } from 'react';
import type { DecisionProjectCounts, ProjectFolder } from '../api';
import { tildePath } from '../format';
import { Icon } from '../icons';

/**
 * The Decisions page's project switch (it replaced a native <select>, which
 * showed only names): a button naming the project and its counts, opening a
 * listbox of every project with its folder and its counts, "N waiting"
 * (questions that record a decision once sent) and "N settled" (decisions
 * that hold). The order is the sidebar's (the store's project order), so a
 * project sits where the person last saw it; the counts are read beside the
 * name, not used to reorder. On a phone the list is a sheet from the bottom
 * edge, as New message's sessions and the decision card are, with a Close.
 *
 * Keys, the listbox pattern: ArrowDown / ArrowUp / Enter / Space on the
 * button open it on the current project; in the list ArrowDown / ArrowUp,
 * Home / End and type-ahead move (the same letter again cycles through the
 * projects it starts; Space joins a name being typed), Enter or Space picks,
 * Escape and Tab close and put focus back on the button (in a phone's sheet
 * Tab moves between the list and Close instead). A press outside
 * closes it and that press's click is swallowed, so it never also opens what
 * lay under the list. A route change (the browser's Back) closes it too.
 */

export interface DecisionsProjectPickerProps {
  projects: readonly ProjectFolder[];
  /** The project shown. */
  current: ProjectFolder;
  /** Every project's counts, by id; absent until the first Decisions read (or from an older Inbox). */
  counts: ReadonlyMap<string, DecisionProjectCounts> | null;
  /** The home folder, for `~/…` paths. */
  home: string | null;
  phone: boolean;
  onPick: (projectId: string) => void;
}

/** "2 waiting · 5 settled", "No decisions yet", or null while unknown. */
export function decisionCountWords(counts: DecisionProjectCounts | undefined): string | null {
  if (!counts) return null;
  const parts: string[] = [];
  if (counts.waiting > 0) parts.push(`${counts.waiting} waiting`);
  if (counts.settled > 0) parts.push(`${counts.settled} settled`);
  return parts.length > 0 ? parts.join(' · ') : 'No decisions yet';
}

/**
 * The phone button's one count, whole (the button has no room for both, and
 * a number is never cut): "N waiting" when anything waits, else "N settled",
 * else nothing. The button's accessible name keeps every count.
 */
export function decisionCountShort(counts: DecisionProjectCounts | undefined): string | null {
  if (!counts) return null;
  if (counts.waiting > 0) return `${counts.waiting} waiting`;
  if (counts.settled > 0) return `${counts.settled} settled`;
  return null;
}

function CountChips({ counts }: { counts: DecisionProjectCounts | undefined }) {
  if (!counts) return null;
  if (counts.waiting === 0 && counts.settled === 0) return <span className="ib-ppick-none">No decisions yet</span>;
  return (
    <>
      {counts.waiting > 0 && (
        <span className="ib-ppick-w" data-count="waiting">
          {counts.waiting} waiting
        </span>
      )}
      {counts.settled > 0 && (
        <span className="ib-ppick-s" data-count="settled">
          {counts.settled} settled
        </span>
      )}
    </>
  );
}

const TYPEAHEAD_MS = 600;

export function DecisionsProjectPicker(props: DecisionsProjectPickerProps) {
  const { projects, current, counts, home, phone } = props;
  const [open, setOpen] = useState(false);
  const base = `ib-ppick-${useId().replace(/:/g, '')}`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  /** The popup: the listbox on a desktop, the sheet (its head and the listbox) on a phone. */
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  /** Closed from the keyboard or by a pick: focus goes back to the button (not after a press elsewhere). */
  const refocus = useRef(false);
  const typed = useRef({ text: '', at: 0 });

  const options = () => [...(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
  const close = (giveFocusBack: boolean) => {
    refocus.current = giveFocusBack;
    setOpen(false);
  };

  useEffect(() => {
    if (open) {
      typed.current = { text: '', at: 0 };
      const items = options();
      const target = items.find((o) => o.getAttribute('aria-selected') === 'true') ?? items[0];
      target?.focus();
      target?.scrollIntoView?.({ block: 'nearest' });
      refocus.current = true;
    } else if (refocus.current) {
      refocus.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  /** Disarms the click swallower an outside press armed (see below), if it is still armed. */
  const disarm = useRef<(() => void) | null>(null);
  useEffect(() => () => disarm.current?.(), []);

  // The route moved under the list (a pick, or the browser's Back on a phone): the list closes.
  useEffect(() => {
    setOpen(false);
    disarm.current?.();
  }, [current.id]);
  useEffect(() => {
    if (!open) return;
    const onPop = () => close(false);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [open]);

  // A press outside the list or its button closes it, focus left where the press put it, and
  // the click that press makes is swallowed, so it does not also open what lay under the list.
  // Only a primary press arms the swallower, only a pointer's click (detail > 0) is swallowed,
  // and it disarms on the tick after the press ends, so a press that makes no click (a right
  // click, a touch that turned into a scroll) never eats a later keyboard click.
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (popRef.current?.contains(target) === true || triggerRef.current?.contains(target) === true);
    const onDown = (event: PointerEvent) => {
      if (inside(event.target)) return;
      close(false);
      if (event.button !== 0) return;
      disarm.current?.();
      let timer: ReturnType<typeof setTimeout> | null = null;
      const swallow = (click: MouseEvent) => {
        if (click.detail === 0) return;
        off();
        if (inside(click.target)) return;
        click.preventDefault();
        click.stopPropagation();
      };
      // The click, when there is one, comes in the same task as pointerup: disarm on the next tick.
      const ended = () => {
        if (timer === null) timer = setTimeout(off, 0);
      };
      const off = () => {
        if (timer !== null) clearTimeout(timer);
        document.removeEventListener('click', swallow, true);
        document.removeEventListener('pointerup', ended, true);
        document.removeEventListener('pointercancel', ended, true);
        if (disarm.current === off) disarm.current = null;
      };
      document.addEventListener('click', swallow, true);
      document.addEventListener('pointerup', ended, true);
      document.addEventListener('pointercancel', ended, true);
      disarm.current = off;
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const pick = (projectId: string) => {
    close(true);
    if (projectId !== current.id) props.onPick(projectId);
  };

  const onTriggerKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
    }
  };

  /** Type-ahead: the project whose name starts with what was typed; the same letter again goes to the next one it starts. */
  const typeAhead = (key: string, items: HTMLElement[], at: number): HTMLElement | undefined => {
    const now = Date.now();
    const text = (now - typed.current.at < TYPEAHEAD_MS ? typed.current.text : '') + key.toLowerCase();
    typed.current = { text, at: now };
    const repeated = [...text].every((c) => c === text[0]);
    const prefix = repeated ? text[0]! : text;
    const start = repeated ? at + 1 : Math.max(at, 0);
    const names = items.map((o) => (o.getAttribute('data-project-name') ?? '').toLowerCase());
    for (let i = 0; i < items.length; i++) {
      const j = (start + i) % items.length;
      if (names[j]!.startsWith(prefix)) return items[j];
    }
    return undefined;
  };

  const onPopKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = options();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const typing = typed.current.text !== '' && Date.now() - typed.current.at < TYPEAHEAD_MS;
    let target: HTMLElement | undefined;
    if (event.key === 'ArrowDown') target = items[Math.min(at + 1, items.length - 1)];
    else if (event.key === 'ArrowUp') target = items[Math.max(at - 1, 0)];
    else if (event.key === 'Home') target = items[0];
    else if (event.key === 'End') target = items[items.length - 1];
    else if (event.key === ' ' && typing) {
      // A space inside a name being typed is part of the name, not a pick.
      target = typeAhead(' ', items, at);
      event.preventDefault();
      event.stopPropagation();
      if (!target) return;
    } else if ((event.key === 'Enter' || event.key === ' ') && at >= 0) {
      event.preventDefault();
      event.stopPropagation();
      const id = items[at]!.getAttribute('data-project-option');
      if (id) pick(id);
      return;
    } else if (event.key === 'Tab' && phone) {
      // The sheet holds two stops, the list and its Close: Tab and Shift+Tab move between them.
      event.preventDefault();
      event.stopPropagation();
      const closeButton = closeRef.current;
      if (document.activeElement === closeButton) {
        const back = items.find((o) => o.getAttribute('aria-selected') === 'true') ?? items[0];
        back?.focus();
        back?.scrollIntoView?.({ block: 'nearest' });
      } else closeButton?.focus();
      return;
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    } else if (event.key.length === 1 && event.key !== ' ' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      target = typeAhead(event.key, items, at);
      if (!target) return;
    } else return;
    event.preventDefault();
    event.stopPropagation();
    target?.focus();
    target?.scrollIntoView?.({ block: 'nearest' });
  };

  const currentCounts = counts?.get(current.id);
  const currentWords = decisionCountWords(currentCounts);
  const buttonWords = phone ? decisionCountShort(currentCounts) : currentWords;
  const listId = `${base}-list`;

  const listbox = (
    <div
      className={phone ? 'ib-ppick-opts' : 'ib-ppick-list'}
      id={listId}
      role="listbox"
      aria-label="Projects"
      ref={(el) => {
        listRef.current = el;
        if (!phone) popRef.current = el;
      }}
      onKeyDown={phone ? undefined : onPopKey}
      data-project-list=""
    >
      {projects.map((project) => {
        const selected = project.id === current.id;
        const projectCounts = counts?.get(project.id);
        const words = decisionCountWords(projectCounts);
        const path = tildePath(project.root, home);
        return (
          <div
            key={project.id}
            id={`${base}-${project.id}`}
            role="option"
            aria-selected={selected}
            aria-label={`${project.name}, ${path}${words ? `, ${words}` : ''}`}
            tabIndex={-1}
            className="ib-ppick-o"
            title={`${project.name}\n${path}`}
            onClick={() => pick(project.id)}
            data-project-option={project.id}
            data-project-name={project.name}
          >
            <span className="ib-ppick-ck" aria-hidden="true">
              {selected && <Icon name="check" size={15} />}
            </span>
            <span className="ib-ppick-ot">
              <b dir="auto">{project.name}</b>
              <span className="ib-ppick-p">{path}</span>
            </span>
            <span className="ib-ppick-oc" aria-hidden="true">
              <CountChips counts={projectCounts} />
            </span>
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="ib-ppick" data-project-picker="">
      <button
        type="button"
        ref={triggerRef}
        className="ib-ppick-t"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`Project: ${current.name}${currentWords ? `, ${currentWords}` : ''}`}
        title={current.name}
        onClick={() => (open ? close(true) : setOpen(true))}
        onKeyDown={onTriggerKey}
        data-project-picker-trigger=""
      >
        <span className="ib-ppick-tn">{current.name}</span>
        {buttonWords && (
          <span className="ib-ppick-tc" aria-hidden="true">
            {buttonWords}
          </span>
        )}
        <Icon name="chevD" size={14} />
      </button>
      {open && phone && (
        <>
          <div className="ib-ppick-scrim" aria-hidden="true" />
          <div className="ib-ppick-list ib-ppick-sheet" ref={popRef} onKeyDown={onPopKey} data-project-sheet="">
            <div className="ib-ppick-h">
              <b>Project</b>
              <button type="button" ref={closeRef} className="ib-iconbtn ib-ppick-x" aria-label="Close the project list" onClick={() => close(true)} data-project-sheet-close="">
                <Icon name="x" size={18} />
              </button>
            </div>
            {listbox}
          </div>
        </>
      )}
      {open && !phone && listbox}
    </div>
  );
}
