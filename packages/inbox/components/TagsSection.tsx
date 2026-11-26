/**
 * The sidebar's Tags section (approval "inbox-thread-tags", step 1): under Starred, above Agents, and absent until a
 * tag holds a thread or the person made one (Sidebar.tsx decides). Its heading folds it like Starred and Projects, and
 * carries `+` (always shown, not only on hover, as Agents' Add agent) for a new tag, typed in a field in the
 * section. Each tag is a plain name; the number is the threads in it waiting on the person, and a tag with none waiting
 * reads quieter. A tag opens its list (`#tag=ini_…`), filled as a project's is.
 *
 * A right-click (or a finger held on it, `useContextMenuTrigger`'s `longPress`) opens Show threads, Rename (the row turns
 * into a field: Enter saves, Escape or leaving the field cancels) and Delete tag (no question: the toast has Undo).
 * Closed, the section keeps only the tag the list shows.
 *
 * The heading's sort toggle orders the tags as Projects' does (tagSort.ts): today's order (oldest first) until the
 * first press, then A to Z or most recent.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { Menu } from '@base-ui/react/menu';
import type { InboxInitiative } from '@plannotator/core/inbox-types';
import { formatCount } from '../format';
import { Icon } from '../icons';
import { Tip } from './Tip';
import { useContextMenuTrigger } from './useContextMenuTrigger';
import { TagColourItem, TagColourList } from './TagColourMenu';
import { MenuCheckbox } from './Tidy';
import { focusAfterSwap } from '@plannotator/ui/components/inbox-thread/SnoozeMenu';
import { tintAttrs } from '../tagColours';
import type { TagColourControls } from '../useThreadTagsHost';
import { setTagSort, sortTags, tagSortControl, useTagSort } from '../tagSort';
import { SectionSortToggle } from './SectionSortToggle';

export interface TagsSectionProps {
  /** The live tags, oldest first. */
  tags: readonly InboxInitiative[];
  /** Per tag, its threads waiting on the person. */
  waiting: ReadonlyMap<string, number>;
  /** The tag the list shows, or null. */
  tagId: string | null;
  closed: boolean;
  onToggle: () => void;
  /** The heading (Sidebar.tsx's section header), and the ids that tie it to the rows. */
  header: ReactNode;
  labelId: string;
  bodyId: string;
  phone: boolean;
  /** Closes a phone's sheet, then goes. */
  pick: (go: () => void) => () => void;
  onOpen: (tagId: string) => void;
  /** Makes a tag; resolves to its id once the sidebar lists it, or null when it was not made (the toast says why). */
  onCreate: (name: string) => Promise<string | null>;
  /** Resolves true once the new name is in. */
  onRename: (tagId: string, name: string) => Promise<boolean>;
  onDelete: (tag: InboxInitiative) => void;
  /** Tag colours (tagColours.ts): each tag's row wears its colour, the key to the list's; null from an older Inbox. */
  colours?: TagColourControls | null;
  /** Each tag's latest activity (`tagActivity`): what "most recent" sorts the tags by. */
  activity?: ReadonlyMap<string, string>;
  /** Says a new order to a screen reader. */
  announce?: (text: string) => void;
}

export function TagsSection(props: TagsSectionProps) {
  const { closed } = props;
  const sort = useTagSort();
  const activity = sort === 'recent' ? props.activity : undefined;
  const tags = useMemo(() => sortTags(props.tags, sort, activity), [props.tags, sort, activity]);
  const sortControl = tagSortControl(sort);
  const body = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(body.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [aimed, setAimed] = useState<string | null>(null);
  // A row to take focus once it is drawn: the tag just made, or the one just renamed.
  const focusRow = useRef<string | null>(null);
  const rowFor = (id: string) => body.current?.querySelector<HTMLElement>(`[data-tag-row="${CSS.escape(id)}"]`) ?? null;
  useLayoutEffect(() => {
    const id = focusRow.current;
    if (!id) return;
    const row = rowFor(id);
    if (!row) return;
    focusRow.current = null;
    row.focus({ preventScroll: true });
  });
  const menu = useContextMenuTrigger({
    itemOf: (target) => (target instanceof Element ? target.closest<HTMLElement>('[data-tag-row]') : null),
    idOf: (row) => row.getAttribute('data-tag-row'),
    has: (id) => tags.some((tag) => tag.id === id),
    buttonFor: rowFor,
    slotOf: () => ({
      order: [...(body.current?.querySelectorAll('[data-tag-row]') ?? [])].map((row) => row.getAttribute('data-tag-row')!),
      fallback: () => head.current?.querySelector<HTMLElement>('[data-sidebar-section="tags"]') ?? null,
    }),
    stateOf: (id) => tags.find((tag) => tag.id === id)?.name ?? '',
    onTarget: setAimed,
    longPress: true,
  });
  const target = menu.targetId ? (tags.find((tag) => tag.id === menu.targetId) ?? null) : null;
  // Highlight rows swaps the menu for the colours in place; each opening starts on the menu.
  const [colourView, setColourView] = useState(false);
  useEffect(() => setColourView(false), [menu.targetId]);
  // Back from the colours: focus returns to Highlight rows.
  const leftColours = useRef(false);
  useLayoutEffect(() => {
    if (colourView) {
      leftColours.current = true;
      return;
    }
    if (!leftColours.current) return;
    leftColours.current = false;
    return focusAfterSwap(() => portal?.querySelector<HTMLElement>('[data-tag-menu] [data-tag-action="colour"]'));
  }, [colourView, portal]);
  const colours = props.colours ?? null;
  const startCreate = () => {
    if (closed) props.onToggle();
    setCreating(true);
  };
  return (
    <div className="ib-tagsec" data-tags-section="" data-closed={closed ? '' : undefined}>
      <div ref={head} className="ib-secrow" data-tags-head="">
        {props.header}
        {!closed && tags.length > 1 && (
          <SectionSortToggle control={sortControl} onPress={() => setTagSort(sortControl.next)} announce={props.announce} className="ib-tags-sort" data={{ 'data-tags-sort': sort }} />
        )}
        <Tip content="New tag">
          <button type="button" className="ib-proj-sort ib-tags-add" aria-label="New tag" data-tags-add="" onClick={startCreate}>
            <Icon name="plus" />
          </button>
        </Tip>
      </div>
      <ContextMenu.Root {...menu.root}>
        <ContextMenu.Trigger ref={body} className="ib-tags" id={props.bodyId} role="group" aria-labelledby={props.labelId} data-closed={closed ? '' : undefined} data-recent={sort === 'recent' ? '' : undefined} {...menu.trigger}>
          {creating && (
            <TagNameField
              name=""
              label="New tag"
              onCancel={(refocus) => {
                setCreating(false);
                if (refocus) head.current?.querySelector<HTMLElement>('[data-tags-add]')?.focus({ preventScroll: true });
              }}
              onSave={async (name) => {
                const id = await props.onCreate(name);
                if (!id) return false;
                focusRow.current = id;
                setCreating(false);
                return true;
              }}
            />
          )}
          {tags.map((tag) => {
            const on = props.tagId === tag.id;
            if (closed && !on) return null;
            if (renaming === tag.id) {
              return (
                <TagNameField
                  key={tag.id}
                  name={tag.name}
                  label="Rename"
                  onCancel={(refocus) => {
                    if (refocus) focusRow.current = tag.id;
                    setRenaming(null);
                  }}
                  onSave={async (name) => {
                    const saved = await props.onRename(tag.id, name);
                    if (saved) {
                      focusRow.current = tag.id;
                      setRenaming(null);
                    }
                    return saved;
                  }}
                />
              );
            }
            const n = props.waiting.get(tag.id) ?? 0;
            const colour = colours?.show ? colours.colourOf(tag.id) : null;
            const tint = colour ? tintAttrs(colour) : null;
            return (
              <button
                key={tag.id}
                type="button"
                className={`ib-proj${n === 0 ? ' ib-proj-quiet' : ''}${on ? ' ib-on' : ''}`}
                aria-current={on ? 'page' : undefined}
                onClick={props.pick(() => props.onOpen(tag.id))}
                data-tag-row={tag.id}
                data-menu={aimed === tag.id ? '' : undefined}
                data-tint={tint?.['data-tint']}
              >
                <span className="ib-name" dir="auto">
                  {tag.name}
                </span>
                {n > 0 && (
                  <span className="ib-n">
                    {formatCount(n)}
                    <span className="ib-sr"> waiting on you</span>
                  </span>
                )}
              </button>
            );
          })}
        </ContextMenu.Trigger>
        <ContextMenu.Portal container={portal ?? undefined}>
          {props.phone && <ContextMenu.Backdrop className="ib-pm-scrim" />}
          <ContextMenu.Positioner className="ib-pm-pos" data-phone={props.phone ? '' : undefined}>
            <ContextMenu.Popup className="ib-pm" aria-label={target?.name ?? 'Tag'} data-tag-menu={target?.id} {...menu.popup}>
              {target && (
                <div className="ib-pm-title" dir="auto" aria-hidden="true">
                  {target.name}
                </div>
              )}
              {target && colourView && colours && <TagColourList tag={target} colours={colours} onBack={() => setColourView(false)} />}
              {target && !(colourView && colours) && (
                <>
                  <Menu.Item className="ib-pmi" label="Show threads" onClick={props.pick(() => props.onOpen(target.id))} data-tag-action="open">
                    <Icon name="inbox" size={15} />
                    Show threads
                  </Menu.Item>
                  <Menu.Item
                    className="ib-pmi"
                    label="Rename"
                    onClick={() => {
                      // The field takes focus: the menu's close puts it nowhere.
                      menu.keepFocus();
                      setRenaming(target.id);
                    }}
                    data-tag-action="rename"
                  >
                    <Icon name="pen" size={15} />
                    Rename
                  </Menu.Item>
                  {colours && (
                    <>
                      {/* Two rows (the owner, 2026-11-16): the tint on and off at once, and the colour chosen apart. */}
                      <MenuCheckbox label="Highlight rows" checked={colours.colourOf(target.id) !== null} onChange={(on) => colours.highlight(target, on)} data-tag-action="highlight" />
                      <TagColourItem colour={colours.pickOf(target.id)} onOpen={() => setColourView(true)} />
                    </>
                  )}
                  <Menu.Separator className="ib-pm-sep" />
                  <Menu.Item
                    className="ib-pmi"
                    label="Delete tag"
                    onClick={() => {
                      menu.follow(target.id);
                      props.onDelete(target);
                    }}
                    data-tag-action="delete"
                  >
                    <Icon name="trash" size={15} />
                    Delete tag
                  </Menu.Item>
                </>
              )}
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </div>
  );
}

/**
 * A tag's name as a field, in a row's place and size (New tag, Rename): it opens holding the name, all of it selected.
 * Enter saves (an empty or unchanged name just closes); Escape cancels, and so does leaving the field. While the save
 * is on its way the field stays, read only; a refused save leaves it open (the toast says why).
 */
function TagNameField(props: { name: string; label: string; onSave: (name: string) => Promise<boolean>; onCancel: (refocus: boolean) => void }) {
  const [value, setValue] = useState(props.name);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Enter or Escape closed the field: a blur as it goes is not "leaving the field".
  const closing = useRef(false);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const close = (refocus: boolean) => {
    closing.current = true;
    props.onCancel(refocus);
  };
  const save = async () => {
    const typed = value.replace(/\s+/g, ' ').trim();
    if (typed === '' || typed === props.name) return close(true);
    setBusy(true);
    closing.current = true;
    if (!(await props.onSave(typed))) {
      closing.current = false;
      setBusy(false);
      input.current?.focus();
    }
  };
  return (
    <input
      ref={input}
      type="text"
      className="ib-proj-rename ib-tag-name"
      aria-label={props.label}
      placeholder={props.label === 'New tag' ? 'New tag' : undefined}
      spellCheck={false}
      autoComplete="off"
      enterKeyHint="done"
      dir="auto"
      value={value}
      readOnly={busy}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => {
        // The window lost focus (another app): the field is still here when the person comes back.
        if (busy || closing.current || !document.hasFocus()) return;
        close(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          // The field's own Escape: nothing above it (the phone's sheet, the list) takes this press.
          event.preventDefault();
          event.stopPropagation();
          if (!busy) close(true);
        } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          if (!busy) void save();
        }
      }}
      data-tag-name-field=""
    />
  );
}
