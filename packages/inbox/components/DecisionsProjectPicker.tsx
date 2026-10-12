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
 * edge, as New message's sessions and the decision card are.
 *
 * Keys, the listbox pattern: ArrowDown / ArrowUp / Enter / Space on the
 * button open it on the current project; in the list ArrowDown / ArrowUp,
 * Home / End and type-ahead move, Enter or Space picks, Escape and Tab close
 * and put focus back on the button. A click outside closes it.
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
  const listRef = useRef<HTMLDivElement>(null);
  /** Which option takes focus when the list opens: the current project, or the first / last. */
  const openAt = useRef<'current' | 'first' | 'last'>('current');
  /** Closed from the keyboard or by a pick: focus goes back to the button (not after a click elsewhere). */
  const refocus = useRef(false);
  const typed = useRef({ text: '', at: 0 });

  const options = () => [...(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];

  useEffect(() => {
    if (open) {
      const items = options();
      const target =
        openAt.current === 'first' ? items[0] : openAt.current === 'last' ? items[items.length - 1] : (items.find((o) => o.getAttribute('aria-selected') === 'true') ?? items[0]);
      target?.focus();
      target?.scrollIntoView?.({ block: 'nearest' });
      refocus.current = true;
    } else if (refocus.current) {
      refocus.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  // A press outside the list or its button closes it, focus left where the press put it.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && (listRef.current?.contains(target) || triggerRef.current?.contains(target))) return;
      refocus.current = false;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  const pick = (projectId: string) => {
    refocus.current = true;
    setOpen(false);
    if (projectId !== current.id) props.onPick(projectId);
  };

  const openFrom = (where: 'current' | 'first' | 'last') => {
    openAt.current = where;
    setOpen(true);
  };

  const onTriggerKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openFrom('current');
    }
  };

  const onListKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const items = options();
    const at = items.indexOf(document.activeElement as HTMLElement);
    let target: HTMLElement | undefined;
    if (event.key === 'ArrowDown') target = items[Math.min(at + 1, items.length - 1)];
    else if (event.key === 'ArrowUp') target = items[Math.max(at - 1, 0)];
    else if (event.key === 'Home') target = items[0];
    else if (event.key === 'End') target = items[items.length - 1];
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      const id = items[at]?.getAttribute('data-project-option');
      if (id) pick(id);
      return;
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      refocus.current = true;
      setOpen(false);
      return;
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      // Type-ahead: the next project whose name starts with what was typed.
      const now = Date.now();
      const text = (now - typed.current.at < TYPEAHEAD_MS ? typed.current.text : '') + event.key.toLowerCase();
      typed.current = { text, at: now };
      const names = items.map((o) => (o.getAttribute('data-project-name') ?? '').toLowerCase());
      const start = text.length === 1 ? at + 1 : Math.max(at, 0);
      for (let i = 0; i < items.length; i++) {
        const j = (start + i) % items.length;
        if (names[j]!.startsWith(text)) {
          target = items[j];
          break;
        }
      }
      if (!target) return;
    } else return;
    event.preventDefault();
    event.stopPropagation();
    target?.focus();
    target?.scrollIntoView?.({ block: 'nearest' });
  };

  const currentCounts = counts?.get(current.id);
  const currentWords = decisionCountWords(currentCounts);
  const listId = `${base}-list`;

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
        onClick={() => (open ? setOpen(false) : openFrom('current'))}
        onKeyDown={onTriggerKey}
        data-project-picker-trigger=""
      >
        <span className="ib-ppick-tn">{current.name}</span>
        {currentWords && (
          <span className="ib-ppick-tc" aria-hidden="true">
            {currentWords}
          </span>
        )}
        <Icon name="chevD" size={14} />
      </button>
      {open && phone && <div className="ib-ppick-scrim" aria-hidden="true" />}
      {open && (
        <div
          className={`ib-ppick-list${phone ? ' ib-ppick-sheet' : ''}`}
          id={listId}
          role="listbox"
          aria-label="Projects"
          ref={listRef}
          onKeyDown={onListKey}
          data-project-list=""
        >
          {phone && (
            <div className="ib-ppick-h" aria-hidden="true">
              Project
            </div>
          )}
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
                  <b>{project.name}</b>
                  <span className="ib-ppick-p">{path}</span>
                </span>
                <span className="ib-ppick-oc" aria-hidden="true">
                  <CountChips counts={projectCounts} />
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
