/**
 * Who gets the reply on a computer, in a thread with more than one agent (approval "inbox-reply-recipient"; placed by
 * "inbox-reply-target-chip", option B "A chip at the start of your words", 2026-11-20, which superseded option E's
 * pill under the box, right): a filled chip at the start of the words' first line, "to [tile] Claude Code
 * (plannotator) ⌄", the words flowing after it (`chip`; drawn by the field, FieldLead.tsx). Without `chip` it is the
 * pill in the box's own row, which a PR's new thread keeps (`PullThreadStart`). A phone keeps its control in the box's
 * row with its bottom sheet (PhoneReplyRecipient.tsx; the owner, 2026-11-20).
 *
 * Tap it for the thread's agents (live first, ended last), the chosen ones
 * ticked. Tap a name: only that agent. Tap a circle: that agent too ("2
 * agents", the names on hover). An ended agent, or one on an older
 * Plannotator, can't be a second recipient. The last row, "Tag another
 * agent", types a real `@`. The list is the `@` list's box and tiles, not its
 * code (that one follows the caret and only adds). When the session asked has
 * ended, a start row closes the list: New message's "+ [mark] New Claude Code
 * session in ledger" (thread/replyStart.ts); it takes the reply alone.
 *
 * The rules are replyRecipients.ts; ThreadPane owns the choice and Send. The
 * rows are named as a phone's sheet names them (thread/recipientNames.ts).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { graphemesOf } from '@plannotator/core/inbox-format';
import { HostMark, Icon } from '../icons';
import { canAddRecipient, type RecipientRow } from '../replyRecipients';
import type { SessionLabels } from '../sessionLabels';
import { namesList } from '../tags';
import { skillMenuHost } from './ComposerField';
import { leadMaxWidth } from './FieldLead';
import { skillListRoom } from '../caretMenu';
import { recipientNames } from '../thread/recipientNames';
import { TagStack } from './TagPicker';
import { isTextCut, Tip } from './Tip';
import { markRecipientList } from '../pageMarks';

/** The longest title the pill (and the chip) shows; a longer one leaves it its fallback name, and the title goes to its hover. */
const PILL_TITLE_MAX = 26;
const NO_LABELS: SessionLabels = {};
const NO_FOLDER = () => '';

function Face({ tile, full, short, ended }: { tile: ReactNode; full: string; short: string; ended: boolean }) {
  return (
    <>
      <span className="ib-rto-l">to</span>
      {tile}
      <span className="ib-rto-n">
        <span className="ib-rto-full" dir="auto">
          {full}
        </span>
        <span className="ib-rto-short" dir="auto">
          {short}
        </span>
      </span>
      {ended && <span className="ib-rto-q">ended</span>}
      <svg className="ib-rto-c" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </>
  );
}

const QUIET: Record<RecipientRow['state'], string | null> = { live: null, ended: 'ended', reader: 'Not woken', old: 'Update' };

/** A start row's lead: New message's "+" and the agent's mark. */
const StartTile = ({ host }: { host: string | null }) => (
  <>
    <span className="ib-cp-plus" aria-hidden="true">
      <Icon name="plus" size={12} />
    </span>
    <span className="ib-atile">
      <HostMark host={host} />
    </span>
  </>
);

/** The list's own gap from the pill (inbox.css sets the same 6 px for `.ib-rpick`'s `bottom`). */
const RPICK_GAP = 6;
/** One whole row and the list's padding: the least list ever shown (a sliver of a row is never shown). */
const RPICK_LEAST = 56;

/**
 * Where the list sits: fixed to the viewport from the pill's measured rect, never inside the reply box's own
 * boxes. The list hangs above the pill; drawn inside the foot it is cut at the pane's top edge (`.ib-pane`
 * clips) and in a short window not every agent shows (#3427). Above the pill by default; below it when the
 * pill sits too close to the thread's header for one whole row above it.
 */
function useListSpot(pillRef: RefObject<HTMLButtonElement | null>, open: boolean, wide: boolean, start = false): CSSProperties | undefined {
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined);
  const measure = useCallback(() => {
    const pill = pillRef.current;
    if (!open || !pill) {
      setStyle((current) => (current === undefined ? current : undefined));
      return;
    }
    const view = pill.ownerDocument.defaultView ?? window;
    const rect = pill.getBoundingClientRect();
    // inbox.css's widths: 300, or 360 with a "start a new session" row (`.ib-rpick:has([data-recipient-start])`).
    const width = Math.min(wide ? 360 : 300, view.innerWidth - 24);
    // The pill's list ends at its right end; the chip's starts at its left end, over the words.
    const left = Math.max(12, Math.min(start ? rect.left : rect.right - width, view.innerWidth - width - 12));
    // The room under the thread's header; `--ib-tg-room` caps the list to it, under inbox.css's own cap.
    const room = skillListRoom(pill);
    const above = rect.top - RPICK_GAP - room.top - 8;
    const next: CSSProperties = {
      position: 'fixed',
      left,
      width,
      right: 'auto',
      margin: 0,
      ...(above >= RPICK_LEAST
        ? { bottom: view.innerHeight - rect.top + RPICK_GAP, top: 'auto', '--ib-tg-room': `${Math.round(above)}px` }
        : { top: rect.bottom + RPICK_GAP, bottom: 'auto', '--ib-tg-room': `${Math.round(Math.max(RPICK_LEAST, room.bottom - rect.bottom - RPICK_GAP - 8))}px` }),
    } as CSSProperties;
    setStyle((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
  }, [open, pillRef, wide, start]);
  // The chip scrolls with the words: a list opened from code (Send for an ended asker, after a long reply) brings it
  // into view first, so the list opens against a chip the person can see.
  useLayoutEffect(() => {
    if (open && start) pillRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [open, start, pillRef]);
  // Every commit (the box grows as the person types); the equality guard converges.
  useLayoutEffect(() => {
    measure();
  });
  // And on anything that moves it without a commit: a scroll anywhere, a resize, the visual viewport.
  useEffect(() => {
    if (!open) return;
    const view = pillRef.current?.ownerDocument.defaultView ?? window;
    const viewport = view.visualViewport;
    const soon = () => measure();
    view.addEventListener('scroll', soon, true);
    view.addEventListener('resize', soon);
    viewport?.addEventListener('resize', soon);
    viewport?.addEventListener('scroll', soon);
    return () => {
      view.removeEventListener('scroll', soon, true);
      view.removeEventListener('resize', soon);
      viewport?.removeEventListener('resize', soon);
      viewport?.removeEventListener('scroll', soon);
    };
  }, [open, measure, pillRef]);
  return style;
}

/** What the pill and the chip show and say for the chosen recipients, named as the list names them. */
function recipientFace(rows: readonly RecipientRow[], chosen: readonly RecipientRow[], labels: SessionLabels, folderOf: (session: string) => string) {
  const one = chosen.length === 1 ? chosen[0]! : null;
  const named = recipientNames(rows, labels, folderOf);
  const nameOf = (row: RecipientRow) => named.get(row.session)?.name ?? row.label;
  /** The wide name: the row's name while it is short enough to fit, else the fallback name. */
  const pillOf = (row: RecipientRow) => {
    const name = nameOf(row);
    return graphemesOf(name).length <= PILL_TITLE_MAX ? name : row.label;
  };
  const names = namesList(chosen.map(nameOf));
  const ended = one?.state === 'ended';
  const tile = one?.start ? (
    <StartTile host={one.host} />
  ) : one ? (
    <span className="ib-atile">
      <HostMark host={one.host} agent={one.session} />
    </span>
  ) : (
    <TagStack participants={chosen} />
  );
  const words = one ? pillOf(one) : `${chosen.length} agents`;
  /** The face leaves something out (several names, a title too long, the fallback name): the hover says it whole. */
  const partial = chosen.length > 1 || (one !== null && words !== nameOf(one));
  return { one, named, nameOf, pillOf, names, ended, tile, words, partial };
}

/** `name` already says `words` as words of its own ("Claude Code (plannotator)" says "plannotator"; "Pipeline" never says "Pi"). */
export function saysWords(name: string, words: string): boolean {
  const edge = (char: string | undefined) => char === undefined || /[\s()·,]/.test(char);
  for (let at = name.indexOf(words); at >= 0; at = name.indexOf(words, at + 1)) {
    if (edge(name[at - 1]) && edge(name[at + words.length])) return true;
  }
  return false;
}

/**
 * The chip shows the short name (inbox.css, `data-narrow`) in a field 480 px wide or less as last measured (a narrow
 * pane). The one source for what it shows and what its name says.
 */
const NARROW_FIELD = 480;
function useNarrowField(chipRef: RefObject<HTMLButtonElement | null>): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const field = chipRef.current?.closest<HTMLElement>('.ib-cfield');
    if (!field) return;
    const measure = () => {
      const width = field.clientWidth;
      if (width > 0) setNarrow(width <= NARROW_FIELD);
    };
    measure();
    if (typeof ResizeObserver !== 'function') return;
    const watch = new ResizeObserver(measure);
    watch.observe(field);
    return () => watch.disconnect();
  }, [chipRef]);
  return narrow;
}

/** The least of a name the chip shows beside "to" before it drops the word (about six letters). */
const NAME_LEAST = 48;
/** How far "to" and the whole name must fit under the chip's widest before a chip that dropped the word shows it again. */
const TO_BACK_ROOM = 2;
/** How far past its widest the chip may need before it drops the word (sub-pixel rounding is no reason to). */
const TO_DROP_SLACK = 0.5;

/** What the chip needs, in px: `fixed` (its padding, the mark, the chevron and their gaps), `to` (the word and its gap), `name` (the whole name's text), and `max`, its widest. */
export interface ChipWidths {
  fixed: number;
  to: number;
  name: number;
  max: number;
}

/**
 * Whether the chip drops its "to" (`data-tight`), from its state now (`tight`). It drops it when "to", the mark, the
 * whole name and the chevron do not fit in its widest (FieldLead.tsx `leadMaxWidth`, 40% of the first line) and
 * either the whole name fits without the word or under `NAME_LEAST` of the name would show beside it (a long name in a
 * split view's 400 px pane: a 274 px first line, so a 109 px chip). Otherwise the word stays and the
 * name gives way with "…". A chip that dropped it shows it again only when everything fits with
 * `TO_BACK_ROOM` to spare, or dropping it no longer helps: a name within a pixel of the edge never flips it back and forth.
 */
export function chipDropsTo(w: ChipWidths, tight: boolean): boolean {
  const withTo = w.fixed + w.to + w.name;
  const helps = w.fixed + w.name <= w.max + TO_DROP_SLACK || w.max - w.fixed - w.to < NAME_LEAST;
  if (!helps) return false;
  return tight ? withTo > w.max - TO_BACK_ROOM : withTo > w.max + TO_DROP_SLACK;
}

/** The width of an element's text as laid out, cut or not (a Range over it, as utils/textCut.ts reads it). */
function textWidth(el: Element): number {
  if (typeof document.createRange !== 'function') return 0;
  const range = document.createRange();
  range.selectNodeContents(el);
  return range.getBoundingClientRect?.().width ?? 0;
}

/**
 * Whether the chip drops its "to" (`chipDropsTo`), measured after each commit and on each resize. Every width it reads
 * is the same whether the word shows or not (the name's text by a Range, the word as last drawn: it is drawn on the
 * first commit, `tight` starting false), and it decides once per shown name, widest and font size, so a decision can
 * never undo itself in a loop of commits.
 */
function useTightChip(chipRef: RefObject<HTMLButtonElement | null>): boolean {
  const [tight, setTight] = useState(false);
  const tightNow = useRef(false);
  /** The word and its gap, as last drawn, and at which font size. */
  const toWidth = useRef<{ px: number; font: string } | null>(null);
  /** What the last decision was made for. */
  const decided = useRef('');
  const measure = useCallback(() => {
    const set = (next: boolean) => {
      if (tightNow.current === next) return;
      tightNow.current = next;
      setTight(next);
    };
    const chip = chipRef.current;
    const field = chip?.closest('.ib-cfield')?.querySelector('textarea');
    const max = chip?.closest('.ib-flead') && field ? leadMaxWidth(field) : null;
    if (!chip || max === null) {
      decided.current = '';
      return set(false);
    }
    const view = chip.ownerDocument.defaultView ?? window;
    const style = view.getComputedStyle(chip);
    const font = style.fontSize;
    const gap = parseFloat(style.columnGap) || 0;
    const to = chip.querySelector<HTMLElement>('.ib-rto-l');
    const shown = !!to && view.getComputedStyle(to).display !== 'none';
    if (shown) toWidth.current = { px: to!.getBoundingClientRect().width + gap, font };
    // The name as it shows: the short one in a narrow field, else the full one (an inline span: its Range, never its box).
    const box = chip.querySelector<HTMLElement>('.ib-rto-n');
    const name = [...chip.querySelectorAll<HTMLElement>('.ib-rto-full, .ib-rto-short')].find((n) => view.getComputedStyle(n).display !== 'none');
    const word = toWidth.current;
    if (!box || !name) return;
    // The word not yet drawn at this font size (the text size changed while it was dropped): draw it once to measure it.
    if (!word || word.font !== font) return shown ? undefined : set(false);
    const key = `${name.textContent ?? ''}|${max}|${font}`;
    if (decided.current === key) return;
    decided.current = key;
    const fixed = chip.getBoundingClientRect().width - box.getBoundingClientRect().width - (shown ? word.px : 0);
    set(chipDropsTo({ fixed, to: word.px, name: textWidth(name), max }, tightNow.current));
  }, [chipRef]);
  useLayoutEffect(() => {
    measure();
  });
  useEffect(() => {
    const chip = chipRef.current;
    const field = chip?.closest('.ib-cfield')?.querySelector('textarea');
    if (!chip || !field || typeof ResizeObserver !== 'function') return;
    const watch = new ResizeObserver(() => measure());
    watch.observe(chip);
    watch.observe(field, { box: 'content-box' });
    return () => watch.disconnect();
  }, [chipRef, measure]);
  return tight;
}

/**
 * The chip at the start of the words' first line (approval "inbox-reply-target-chip", option B): a filled token, "to
 * [tile] Pi ⌄", the same words and names as the pill. A long name gives way with "…" (inbox.css caps the chip), and
 * then, as when it shows a fallback name, the short name or "2 agents", the hover says who in full. Its accessible
 * name is the pill's, led by the words it shows when those differ ("To Pi · Copy pass on the order summary").
 */
function RecipientChip({
  rows,
  chosen,
  open,
  onClick,
  labels = NO_LABELS,
  folderOf = NO_FOLDER,
  noun = 'reply',
  buttonRef,
  attrs,
}: {
  rows: readonly RecipientRow[];
  chosen: readonly RecipientRow[];
  open: boolean;
  onClick: () => void;
  labels?: SessionLabels;
  folderOf?: (session: string) => string;
  noun?: 'reply' | 'message';
  buttonRef?: RefObject<HTMLButtonElement | null>;
  /** `aria-*` and `data-*` attributes of the host (the list it controls). */
  attrs?: Record<string, string | undefined>;
}) {
  const { one, names, ended, tile, words, partial } = recipientFace(rows, chosen, labels, folderOf);
  const ownRef = useRef<HTMLButtonElement | null>(null);
  const narrow = useNarrowField(ownRef);
  const tight = useTightChip(ownRef);
  // The name starts with the words the chip shows (a narrow field's short name, a fallback name), then who that is,
  // when those words are not already in it: "To Pi · Copy pass on the order summary".
  const shown = one ? (narrow ? one.short : words) : null;
  const spoken = shown && !saysWords(names, shown) ? `${shown} · ${names}` : names;
  return (
    <Tip content={names} when={(trigger) => !open && (partial || (narrow && one !== null && one.short !== names) || isTextCut(trigger.querySelector('.ib-rto-n')))}>
      <button
        ref={(node) => {
          ownRef.current = node;
          if (buttonRef) buttonRef.current = node;
        }}
        type="button"
        className="ib-rto-chip"
        data-recipient=""
        data-recipient-chip=""
        data-recipient-chosen={chosen.map((r) => r.session).join(' ')}
        data-ended={ended ? '' : undefined}
        data-narrow={narrow ? '' : undefined}
        data-tight={tight ? '' : undefined}
        aria-label={`To ${spoken}${ended ? ', ended' : ''}. Change who gets this ${noun}`}
        aria-expanded={open}
        // The press must not take focus from the words.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClick}
        {...attrs}
      >
        <Face tile={tile} full={words} short={one ? one.short : words} ended={ended} />
      </button>
    </Tip>
  );
}

export function ReplyRecipient({
  rows,
  chosen,
  open,
  onOpen,
  onOnly,
  onToggle,
  onTagAnother,
  labels = NO_LABELS,
  folderOf = NO_FOLDER,
  noun = 'reply',
  chip = false,
}: {
  /** Every agent the list offers, live first, ended last. */
  rows: readonly RecipientRow[];
  /** Who gets the reply now, the one it answers first (a typed `@` included). */
  chosen: readonly RecipientRow[];
  open: boolean;
  onOpen: (open: boolean) => void;
  onOnly: (row: RecipientRow) => void;
  /** Add a second recipient. Absent (a PR's new thread, `PullThreadStart`): one recipient only, a circle only shows the choice. */
  onToggle?: (row: RecipientRow) => void;
  /** The last row, "Tag another agent". Absent: no such row. */
  onTagAnother?: () => void;
  /** Each session's title, where it has one: the pill and the list show it over the fallback name. */
  labels?: SessionLabels;
  /** The folder a session works in, as the thread knows it. */
  folderOf?: (session: string) => string;
  /** What is sent: a reply, or a PR's new thread's first message (`PullThreadStart`), as the names read it. */
  noun?: 'reply' | 'message';
  /** The chip at the start of the words (a thread's reply box, drawn as the field's lead), not the pill in the row. */
  chip?: boolean;
}) {
  const listId = useRef(`ib-rpick-${Math.random().toString(36).slice(2)}`).current;
  const pillRef = useRef<HTMLButtonElement | null>(null);
  const spot = useListSpot(pillRef, open, rows.some((row) => row.start), chip);
  const host = pillRef.current ? skillMenuHost(pillRef.current) : null;
  const chosenIds = chosen.map((r) => r.session);
  const { one, named, nameOf, pillOf, names, ended, tile, words, partial } = recipientFace(rows, chosen, labels, folderOf);

  // A press outside the pill and its list closes the list; so does Escape, before anything else hears it.
  useEffect(() => {
    if (!open) return;
    const press = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest?.('[data-recipient-list], [data-recipient]')) onOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onOpen(false);
    };
    document.addEventListener('pointerdown', press);
    window.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', press);
      window.removeEventListener('keydown', key, true);
    };
  }, [open, onOpen]);

  const button = (
    <button
      ref={pillRef}
      type="button"
      className="ib-rto"
      data-recipient=""
      data-ended={ended ? '' : undefined}
      aria-label={`To ${names}${ended ? ', ended' : ''}. Change who gets this ${noun}`}
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      // The press must not take focus from the reply field.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onOpen(!open)}
    >
      <Face tile={tile} full={words} short={one ? one.short : words} ended={ended} />
    </button>
  );

  const list = open ? (
    <div ref={markRecipientList} className="ib-tg-menu ib-rpick" id={listId} data-recipient-list="" role="group" aria-label={`Who gets this ${noun}`} onMouseDown={(event) => event.preventDefault()} style={spot}>
      {rows.map((row) => {
        const on = chosenIds.includes(row.session);
        const { title, agent } = named.get(row.session)!;
        const quiet = QUIET[row.state];
        if (row.start || !onToggle) {
          // Picked like a name; its circle only shows the choice (a new session is never a second recipient).
          return (
            <div key={row.session} className="ib-rpick-row" data-recipient-row={row.session} data-recipient-start={row.host ?? ''} data-on={on ? '' : undefined}>
              {row.start ? (
                <button type="button" className="ib-rpick-name" aria-label={`${row.label} in ${row.start.project}`} onClick={() => onOnly(row)}>
                  <StartTile host={row.host} />
                  <span className="ib-rpick-l" dir="auto">
                    {row.label}
                  </span>
                  <span className="ib-cp-stin" dir="auto">
                    in {row.start.project}
                  </span>
                  {row.start.asleep && <span className="ib-rpick-q">starts when it's back</span>}
                </button>
              ) : (
                <button type="button" className="ib-rpick-name" disabled={row.alone === false} onClick={() => onOnly(row)}>
                  <span className="ib-atile">
                    <HostMark host={row.host} agent={row.session} />
                  </span>
                  <span className="ib-rpick-ol">
                    <span className="ib-rpick-l" dir="auto" title={title ? nameOf(row) : undefined}>
                      {nameOf(row)}
                    </span>
                    <span className="ib-rpick-d" dir="auto">
                      {agent && `${agent} · `}
                      {quiet ? <span className="ib-rpick-q">{quiet}</span> : folderOf(row.session)}
                    </span>
                  </span>
                </button>
              )}
              <button type="button" role="checkbox" aria-checked={on} aria-hidden="true" tabIndex={-1} className="ib-rpick-tick" onClick={() => onOnly(row)}>
                <span>
                  <Icon name="check" size={12} />
                </span>
              </button>
            </div>
          );
        }
        return (
          <div key={row.session} className="ib-rpick-row" data-recipient-row={row.session} data-on={on ? '' : undefined}>
            <button type="button" className="ib-rpick-name" disabled={row.alone === false} onClick={() => onOnly(row)}>
              <span className="ib-atile">
                <HostMark host={row.host} agent={row.session} />
              </span>
              <span className="ib-rpick-ol">
                <span className="ib-rpick-l" dir="auto" title={title ? nameOf(row) : undefined}>
                  {nameOf(row)}
                </span>
                <span className="ib-rpick-d" dir="auto">
                  {agent && `${agent} · `}
                  {quiet ? <span className="ib-rpick-q">{quiet}</span> : folderOf(row.session)}
                </span>
              </span>
            </button>
            <button
              type="button"
              role="checkbox"
              aria-checked={on}
              aria-label={`Also send to ${nameOf(row)}`}
              className="ib-rpick-tick"
              data-recipient-tick={row.session}
              disabled={!canAddRecipient(row, chosenIds, rows)}
              onClick={() => onToggle!(row)}
            >
              <span>
                <Icon name="check" size={12} />
              </span>
            </button>
          </div>
        );
      })}
      {onTagAnother && (
        <button type="button" className="ib-rpick-more" data-recipient-tag="" onClick={onTagAnother}>
          Tag another agent
        </button>
      )}
    </div>
  ) : null;

  // The list portals out of the reply box's own boxes (see useListSpot): nothing renders in place.
  const portal = list && host && spot ? createPortal(list, host) : null;
  if (chip) {
    return (
      <>
        <RecipientChip rows={rows} chosen={chosen} open={open} onClick={() => onOpen(!open)} labels={labels} folderOf={folderOf} noun={noun} buttonRef={pillRef} attrs={{ 'aria-controls': open ? listId : undefined }} />
        {portal}
      </>
    );
  }
  const pill = <span className="ib-rto-wrap">{!open && partial ? <Tip content={names}>{button}</Tip> : button}</span>;
  // A wide window: every name stacked under the pill, so the Draft words beside it never move when it changes.
  return (
    <span className="ib-rto-slot">
      {rows.map((row) => (
        <span key={row.session} className="ib-rto ib-rto-ghost" aria-hidden="true">
          <Face tile={<span className="ib-atile" />} full={pillOf(row)} short={row.short} ended={row.state === 'ended'} />
        </span>
      ))}
      {pill}
      {portal}
    </span>
  );
}
