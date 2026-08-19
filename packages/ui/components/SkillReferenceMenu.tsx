import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SkillCatalogEntry } from '../utils/skillReferences';

/** Which skill root a row came from, shown as the right-aligned source column. */
const ROOT_LABELS: Record<SkillCatalogEntry['root'], string> = {
  claude: 'Claude',
  codex: 'Codex',
  universal: 'Agents',
};

interface SkillReferenceMenuProps {
  /** Id referenced by the focused textarea's aria-controls attribute. */
  id: string;
  items: SkillCatalogEntry[];
  /** Explicitly activated row, or null — the menu opens with nothing active. */
  activeIndex: number | null;
  onSelect: (index: number) => void;
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
function computeMenuPlacement(
  anchorRect: Pick<DOMRect, 'top' | 'bottom'>,
  naturalListHeight: number,
  chromeHeight: number,
  viewportHeight: number,
): MenuPlacement {
  const spaceAbove = anchorRect.top - MENU_GAP - MENU_VIEWPORT_MARGIN - chromeHeight;
  const spaceBelow = viewportHeight - anchorRect.bottom - MENU_GAP - MENU_VIEWPORT_MARGIN - chromeHeight;
  const needed = Math.min(naturalListHeight, MAX_LIST_HEIGHT);
  const direction: MenuPlacement['direction'] =
    needed <= spaceAbove ? 'above'
    : needed <= spaceBelow ? 'below'
    : spaceAbove >= spaceBelow ? 'above'
    : 'below';
  const available = direction === 'above' ? spaceAbove : spaceBelow;
  return {
    direction,
    maxListHeight: Math.max(0, Math.min(MAX_LIST_HEIGHT, Math.round(available))),
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
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<MenuPlacement>({
    direction: 'above',
    maxListHeight: MAX_LIST_HEIGHT,
  });

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
    const next = computeMenuPlacement(rect, listEl.scrollHeight, chrome, window.innerHeight);
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
    const row = list?.children[activeIndex] as HTMLElement | undefined;
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
        {items.map((item, index) => (
          <button
            key={item.name}
            type="button"
            id={`${id}-option-${index}`}
            role="option"
            aria-selected={index === activeIndex}
            tabIndex={-1}
            data-skill-item={item.name}
            data-skill-item-active={index === activeIndex ? 'true' : undefined}
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
            <SkillIcon />
            <span className="shrink-0 font-semibold text-foreground">{item.name}</span>
            <span className="min-w-0 flex-1 truncate text-muted-foreground">
              {item.description ?? ''}
            </span>
            <span className="shrink-0 pl-3 text-xs text-muted-foreground/80">
              {ROOT_LABELS[item.root]}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
};

const SkillIcon: React.FC = () => (
  <svg
    className="w-4 h-4 shrink-0 text-muted-foreground"
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
export const HumanOnlySkillNotice: React.FC<HumanOnlySkillNoticeProps> = ({ skills }) => {
  if (skills.length === 0) return null;
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
            its instructions will be included with your feedback.
          </>
        ) : (
          <>
            <span className="font-mono">{names}</span> cannot be invoked by a model, so
            their instructions will be included with your feedback.
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
