import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SkillCatalogEntry } from '../utils/skillReferences';

/** Which skill root a row came from, shown as the right-aligned source column. */
const ROOT_LABELS: Record<SkillCatalogEntry['root'], string> = {
  claude: 'Claude',
  codex: 'Codex',
  universal: 'Agents',
  plannotator: 'Plannotator',
};

interface SkillReferenceMenuProps {
  /** Id referenced by the focused textarea's aria-controls attribute. */
  id: string;
  items: SkillCatalogEntry[];
  /** Explicitly activated row, or null — the menu opens with nothing active. */
  activeIndex: number | null;
  onSelect: (index: number) => void;
  /**
   * The box the menu must stay inside, in viewport coordinates, read at each
   * measure. Default: the viewport. A host whose composer sits in a dialog
   * with a footer passes the dialog's area above the footer.
   */
  boundary?: () => { top: number; bottom: number } | null;
  /** Which side of the anchor the menu tries first. Default: above. */
  prefer?: 'above' | 'below';
  /** Upper bound on the list's height, in px. Default: 256. */
  maxListHeight?: number;
  /**
   * Draw the host-served rows (root `plannotator`) as their own group (opt-in; the Inbox's "/" list): their icon in
   * the theme's primary colour, and one hairline between the last of them and the first other row, only when both
   * kinds are listed. The hairline is presentational (no role, hidden from assistive tech): the options, their ids
   * and their order are the same with or without it. The caller lists those rows first (the hook's `hostRowsFirst`).
   * Absent: every row alike, as before.
   */
  groupHostRows?: boolean;
  /**
   * A host's own glyph for a row, in place of the cube (opt-in; the Inbox gives each of its built-ins one). It must
   * be the cube's frame (16 px, `shrink-0`, decorative: `aria-hidden`), so no row changes size. Null or undefined
   * for a row keeps the cube. Absent: the cube on every row, as before.
   */
  rowIcon?: (item: SkillCatalogEntry) => React.ReactNode;
}

/** Vertical gap between the composer wrapper and the menu (mb-1.5 / mt-1.5 = 6px). */
const MENU_GAP = 6;
/** Breathing room kept between the menu and the viewport edge. */
const MENU_VIEWPORT_MARGIN = 8;
/** Upper bound on the scrollable list height — the former fixed `max-h-64`. */
const MAX_LIST_HEIGHT = 256;

interface MenuPlacement {
  direction: 'above' | 'below';
  maxListHeight: number;
}

/**
 * Adaptive placement, the same viewport-measurement idiom CommentPopover's
 * `computePosition` uses (space vs `window.innerHeight`). The menu PREFERS
 * opening above the composer — that keeps the text being typed, the action
 * row, and the human-only notice unobstructed, and matches how chat-composer
 * autocompletes behave — and flips below when the list does not fit above but
 * does fit below (the popover near the top of the viewport: the exact case
 * where the old fixed `bottom-full` menu ran off the top of the screen).
 * When neither side fits the whole list, the side with more room wins and the
 * list is clamped to it, so the menu never extends past a viewport edge.
 */
export function computeMenuPlacement(
  anchorRect: Pick<DOMRect, 'top' | 'bottom'>,
  naturalListHeight: number,
  chromeHeight: number,
  viewportHeight: number,
  options: { boundaryTop?: number; prefer?: 'above' | 'below'; maxListHeight?: number } = {},
): MenuPlacement {
  const boundaryTop = options.boundaryTop ?? 0;
  const cap = Number.isFinite(options.maxListHeight) ? options.maxListHeight! : MAX_LIST_HEIGHT;
  const spaceAbove = anchorRect.top - boundaryTop - MENU_GAP - MENU_VIEWPORT_MARGIN - chromeHeight;
  const spaceBelow = viewportHeight - anchorRect.bottom - MENU_GAP - MENU_VIEWPORT_MARGIN - chromeHeight;
  const needed = Math.min(naturalListHeight, cap);
  const [first, second] = options.prefer === 'below' ? (['below', 'above'] as const) : (['above', 'below'] as const);
  const space = (side: MenuPlacement['direction']) => (side === 'above' ? spaceAbove : spaceBelow);
  const direction: MenuPlacement['direction'] =
    needed <= space(first) ? first
    : needed <= space(second) ? second
    : space(first) >= space(second) ? first
    : second;
  const available = space(direction);
  return {
    direction,
    // A NaN reading (a host's boundary or cap mid-rotation) keeps the cap: NaN never equals itself, so the
    // equality-guarded setPlacement below would re-render forever (React error 185, the page goes blank).
    maxListHeight: Number.isFinite(available) ? Math.max(0, Math.min(cap, Math.round(available))) : cap,
  };
}

/**
 * Dropdown for skill references inside a comment composer. Rendered adjacent
 * to the textarea (absolute within a relative wrapper), opening above or
 * below depending on available viewport space (see computeMenuPlacement), and
 * clamped so it never runs off screen. Each row: icon, bold name, dimmed
 * inline description (ellipsis-truncated), right-aligned source root.
 * Human-invocation-only skills render identically to every other row: their
 * instructions are injected into the exported feedback automatically, so the
 * distinction needs no surfacing at pick time. (A hover-disclosed warning
 * used to live here; because it changed the menu's height while the pointer
 * sat over a row of a bottom-anchored menu, it oscillated the row under the
 * cursor every frame. Hover must never change any row's rendered size or the
 * menu's measured geometry — color-only hover styling is fine.)
 *
 * Activation is KEYBOARD-ONLY (see useSkillReferenceAutocomplete): the menu
 * floats directly over the composer, exactly where the mouse rests while
 * typing, so pointer hover must never arm the "Enter inserts" state. Hover is
 * a purely visual affordance; a pointer click inserts directly.
 */
export const SkillReferenceMenu: React.FC<SkillReferenceMenuProps> = ({
  id,
  items,
  activeIndex,
  onSelect,
  boundary,
  prefer,
  maxListHeight,
  groupHostRows = false,
  rowIcon,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<MenuPlacement>({
    direction: prefer ?? 'above',
    maxListHeight: maxListHeight ?? MAX_LIST_HEIGHT,
  });
  // The optional seams, read through a ref so `measure` stays stable for its listeners.
  const optionsRef = useRef({ boundary, prefer, maxListHeight });
  optionsRef.current = { boundary, prefer, maxListHeight };

  const measure = useCallback(() => {
    const menuEl = menuRef.current;
    const listEl = listRef.current;
    // The menu is a direct child of the composer's `relative` wrapper — the
    // same box the `bottom-full` / `top-full` CSS anchors to.
    const anchor = menuEl?.parentElement;
    if (!menuEl || !listEl || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    // Non-list height the menu carries (border). This must stay constant
    // while the pointer moves — hover-dependent chrome is what caused the
    // jitter loop this component once shipped.
    const chrome = Math.max(0, menuEl.offsetHeight - listEl.offsetHeight);
    // scrollHeight reports full content height even while clamped.
    const { boundary: readBoundary, prefer: side, maxListHeight: cap } = optionsRef.current;
    const box = readBoundary?.() ?? null;
    const next = computeMenuPlacement(rect, listEl.scrollHeight, chrome, box ? box.bottom : window.innerHeight, {
      boundaryTop: box ? box.top : 0,
      prefer: side,
      maxListHeight: cap,
    });
    setPlacement((prev) =>
      prev.direction === next.direction && prev.maxListHeight === next.maxListHeight
        ? prev
        : next,
    );
  }, []);

  // Re-measure on EVERY commit: the popover re-renders on drag moves, flips,
  // and filtering (item-count changes), and each of those can change the
  // geometry without any window event firing. The setState above is
  // equality-guarded, so this converges instead of looping.
  useLayoutEffect(() => {
    measure();
  });

  // Same listeners CommentPopover's own position tracking uses: capture-phase
  // scroll (the document scrolls under the anchored popover) plus resize.
  useEffect(() => {
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [measure]);

  useEffect(() => {
    if (activeIndex === null) return;
    const list = listRef.current;
    // By id, not by position: a group's hairline is a child of the list too.
    const row = list?.querySelector<HTMLElement>(`[id="${id}-option-${activeIndex}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <div
      ref={menuRef}
      id={id}
      role="listbox"
      data-skill-menu="true"
      data-skill-menu-placement={placement.direction}
      data-popover-layer="true"
      className={`absolute left-0 right-0 z-[110] bg-popover border border-border rounded-xl shadow-2xl overflow-hidden ${
        placement.direction === 'above' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
      }`}
    >
      <div
        ref={listRef}
        data-skill-menu-list="true"
        className="overflow-y-auto p-1.5 flex flex-col gap-px"
        style={{ maxHeight: placement.maxListHeight }}
      >
        {items.map((item, index) => {
          const hostRow = groupHostRows && item.root === 'plannotator';
          // The one hairline: under the last host-served row, when a row of another kind follows it.
          const next = items[index + 1];
          const dividerAfter = hostRow && next !== undefined && next.root !== 'plannotator';
          return (
          <React.Fragment key={item.name}>
          <button
            type="button"
            id={`${id}-option-${index}`}
            role="option"
            aria-selected={index === activeIndex}
            tabIndex={-1}
            data-skill-item={item.name}
            data-skill-item-active={index === activeIndex ? 'true' : undefined}
            data-skill-item-host={hostRow ? 'true' : undefined}
            // Insert on pointerdown so the textarea never loses focus. A
            // click is explicit selection; hover deliberately does NOT
            // activate the row (see the component docblock), and its only
            // styling is the color-only hover:bg — hover must never change
            // a row's rendered size or the menu's geometry.
            onPointerDown={(e) => {
              e.preventDefault();
              onSelect(index);
            }}
            className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-[13px] leading-snug transition-colors ${
              index === activeIndex ? 'bg-muted' : 'hover:bg-muted/50'
            }`}
          >
            {rowIcon?.(item) ?? <SkillIcon className={hostRow ? 'text-primary' : undefined} />}
            {/* data-skill-item-part: a host's styling hook (the Inbox lays a row out in two lines on a phone). */}
            <span data-skill-item-part="name" className="shrink-0 font-semibold text-foreground">{item.name}</span>
            <span data-skill-item-part="description" className="min-w-0 flex-1 truncate text-muted-foreground">
              {item.description ?? ''}
            </span>
            <span data-skill-item-part="root" className="shrink-0 pl-3 text-xs text-muted-foreground/80">
              {ROOT_LABELS[item.root]}
            </span>
          </button>
          {dividerAfter && <div aria-hidden="true" data-skill-menu-divider="true" className="mx-2.5 my-1 h-px shrink-0 bg-border" />}
          </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};

const SkillIcon: React.FC<{ className?: string }> = ({ className = 'text-muted-foreground' }) => (
  <svg
    className={`w-4 h-4 shrink-0 ${className}`}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.7}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
    <path d="M3.29 7 12 12l8.71-5" />
    <path d="M12 22V12" />
  </svg>
);

interface HumanOnlySkillNoticeProps {
  skills: SkillCatalogEntry[];
  /**
   * What the instructions go with. Default: the host's (`setSkillInstructionsDestination`),
   * else "your feedback". The Inbox says "your reply" or "your message".
   */
  destination?: string;
}

// Module-level seam (see packages/ui/CLAUDE.md): what every composer's
// human-only line says the instructions go with, unless the composer says.
// Plannotator's comments go with "your feedback"; the Inbox's comments on
// attached files ride a reply.
const DEFAULT_DESTINATION = 'your feedback';
let defaultDestination = DEFAULT_DESTINATION;

export function setSkillInstructionsDestination(destination: string): void {
  defaultDestination = destination || DEFAULT_DESTINATION;
}

export function resetSkillInstructionsDestination(): void {
  defaultDestination = DEFAULT_DESTINATION;
}

/**
 * Composer note while human-only skill references are present. Quiet by
 * design: the user already chose to insert the reference (and saw the menu's
 * disclosure while choosing), so the resting state is a single muted summary
 * line rather than a standing explanation. The full plain-language sentence
 * is one native disclosure away — <details>/<summary> keeps the expansion
 * reachable by pointer, keyboard (the summary is focusable; Enter/Space
 * toggles), and assistive tech alike. It pairs with the dotted-underline
 * marker the composer overlay paints on human-only tokens.
 */
export const HumanOnlySkillNotice: React.FC<HumanOnlySkillNoticeProps> = ({ skills, destination }) => {
  if (skills.length === 0) return null;
  destination ??= defaultDestination;
  const names = skills.map((s) => s.name).join(', ');
  return (
    <details data-skill-human-only-notice="true" className="group mt-1 px-1">
      <summary className="list-none [&::-webkit-details-marker]:hidden inline-flex cursor-pointer select-none items-center gap-1 rounded text-[10px] text-muted-foreground/80 transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <DisclosureChevron />
        Includes skill instructions
      </summary>
      <p className="mt-0.5 pl-3.5 text-[11px] leading-snug text-muted-foreground">
        {skills.length === 1 ? (
          <>
            <span className="font-mono">{names}</span> cannot be invoked by a model, so
            its instructions will be included with {destination}.
          </>
        ) : (
          <>
            <span className="font-mono">{names}</span> cannot be invoked by a model, so
            their instructions will be included with {destination}.
          </>
        )}
      </p>
    </details>
  );
};

const DisclosureChevron: React.FC = () => (
  <svg
    className="w-2.5 h-2.5 shrink-0 transition-transform group-open:rotate-90"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m9 18 6-6-6-6" />
  </svg>
);
