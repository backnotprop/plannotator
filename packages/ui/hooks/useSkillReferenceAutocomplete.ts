import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import {
  extractSkillReferences,
  filterSkillCatalog,
  findSkillReferenceTokens,
  findSkillTrigger,
  insertSkillReference,
  type SkillCatalogEntry,
  type SkillReferenceToken,
  type SkillTriggerContext,
} from '../utils/skillReferences';
import { fetchSkillCatalog, getCachedSkillCatalog } from '../utils/skillCatalog';

export interface SkillReferenceMenuState {
  items: SkillCatalogEntry[];
  /** Explicitly activated row, or null — the menu opens with NOTHING active. */
  activeIndex: number | null;
  query: string;
}

export interface UseSkillReferenceAutocompleteResult {
  /** Open menu state, or null. Render SkillReferenceMenu from this. */
  menu: SkillReferenceMenuState | null;
  /** Call FIRST in the textarea's onKeyDown; true means the event was consumed. */
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Call from the textarea's onSelect (fires on every caret move + input). */
  onSelect: () => void;
  /** Insert the given menu item at the active trigger. */
  select: (index: number) => void;
  /** Human-only skills currently referenced in the text (drives the composer warning). */
  humanOnlyReferences: SkillCatalogEntry[];
  /** Positioned reference occurrences in the text (drives the composer highlight overlay). */
  referenceTokens: SkillReferenceToken[];
}

/**
 * Skill-reference autocomplete for a comment textarea. Typing `/` or `$` at
 * the start of a word opens a menu of the user's global agent skills; the
 * catalog is fetched lazily (memory-cached, never persisted). With no catalog
 * (endpoint absent, discovery failed, no skills installed) every path here is
 * inert and the textarea behaves exactly as before.
 *
 * NO-PRESELECTION INVARIANT (do not weaken — an adversarial review proved the
 * failure): the menu opens with no row active, and while no row is active
 * Enter, Tab, and every other typing key behave exactly as if the menu were
 * not open — "This costs $" + Enter is a newline, "cd /" + Tab leaves the
 * field. A row becomes active ONLY via explicit keyboard navigation
 * (ArrowDown from none lands on the FIRST row, ArrowUp from none on the
 * LAST) — and on a BARE trigger (zero query characters) even the arrows pass
 * through to the textarea and dismiss the menu, because in a multi-line
 * composer "cost: $" + ArrowUp means caret navigation, not menu navigation;
 * arrows engage the menu only once a query character was typed. Only with an
 * active row do Enter and Tab insert. Pointer hover never activates a
 * row (a menu rendered over the composer sits exactly where the mouse rests
 * while typing); a pointer CLICK inserts directly and never arms Enter.
 * Continuing to type re-filters the list and DISARMS any active row, so an
 * activation always refers to the exact list the user saw. Escape clears the
 * active row and dismisses the menu when the user has engaged with it (a row
 * is active or a query was typed); on a bare-trigger menu with no engagement
 * it passes through, so Escape still closes the composer in one press.
 */
export function useSkillReferenceAutocomplete(options: {
  text: string;
  setText: (text: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  enabled: boolean;
}): UseSkillReferenceAutocompleteResult {
  const { text, setText, textareaRef, enabled } = options;
  // Seed from the memory cache only when the surface opted in — a disabled
  // composer must stay inert even after another surface warmed the catalog.
  const [catalog, setCatalog] = useState<SkillCatalogEntry[]>(() =>
    enabled ? getCachedSkillCatalog() : [],
  );
  const [caret, setCaret] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  // Escape dismisses the menu for the trigger it was open on; the same trigger
  // does not reopen until the user leaves it (new trigger start clears this).
  const [dismissedStart, setDismissedStart] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchSkillCatalog().then((skills) => {
      if (!cancelled) setCatalog(skills);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const trigger: SkillTriggerContext | null = useMemo(() => {
    if (!enabled || catalog.length === 0 || caret === null) return null;
    return findSkillTrigger(text, caret);
  }, [enabled, catalog, text, caret]);

  const items = useMemo(
    () => (trigger ? filterSkillCatalog(catalog, trigger.query) : []),
    [catalog, trigger],
  );

  const open = trigger !== null && items.length > 0 && trigger.start !== dismissedStart;

  // A new trigger start clears the dismissal memory.
  const lastTriggerStart = useRef<number | null>(null);
  useEffect(() => {
    const start = trigger?.start ?? null;
    if (start !== lastTriggerStart.current) {
      lastTriggerStart.current = start;
      setDismissedStart(null);
    }
  }, [trigger]);

  // Any trigger change — a new trigger OR more typing re-filtering the same
  // one — disarms the active row. An activation must always refer to the
  // exact list the user was looking at when they pressed the arrow key.
  const triggerStart = trigger?.start ?? null;
  const triggerQuery = trigger?.query ?? null;
  useEffect(() => {
    setActiveIndex(null);
  }, [triggerStart, triggerQuery]);

  // Never let a stale activation point past the list (catalog refreshes can
  // shrink it without a query change). Out of range reads as "nothing active".
  const boundedActive =
    activeIndex !== null && activeIndex >= 0 && activeIndex < items.length ? activeIndex : null;

  const readCaret = useCallback(() => {
    const el = textareaRef.current;
    setCaret(el ? el.selectionStart : null);
  }, [textareaRef]);

  const select = useCallback(
    (index: number) => {
      const el = textareaRef.current;
      if (!trigger || !el) return;
      const item = items[index];
      if (!item) return;
      const result = insertSkillReference(text, el.selectionStart, trigger, item);
      setText(result.text);
      setCaret(result.caret);
      setActiveIndex(null);
      // Close deterministically. The DOM caret only moves in the 0ms timer
      // below, and React's select plugin can re-read the STALE caret before
      // then (mousedown/keydown fire onSelect), which would transiently
      // re-open the menu on the just-replaced query. Dismissing the trigger
      // start makes the close ordering-safe; the dismissal clears itself as
      // soon as the trigger changes (including to null when the caret lands).
      setDismissedStart(trigger.start);
      // Restore focus + caret after React commits the new value.
      setTimeout(() => {
        if (!el.isConnected) return;
        el.focus();
        el.setSelectionRange(result.caret, result.caret);
      }, 0);
    },
    [items, setText, text, textareaRef, trigger],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open) return false;
      // IME composition: for Pinyin, Telex, 2-set Korean and friends the
      // composition buffer is ASCII, so the menu can be open exactly when
      // Enter means "commit this candidate" and the arrows drive the
      // candidate list. Never consume keys mid-composition. With bare
      // triggers opening the menu, this guard is MORE load-bearing than
      // before: the menu is open during more compositions.
      if (e.nativeEvent.isComposing) return false;
      if (e.metaKey || e.ctrlKey || e.altKey) return false;
      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowUp':
          // BARE trigger, zero query, nothing active: the arrows were aimed
          // at the textarea (proven regression: "first line\ncost: $" +
          // ArrowUp must move the caret up, not arm the menu's last row so
          // the next Enter inserts a skill). Dismiss the menu and pass the
          // key through. Once the user has typed a query character — or
          // engaged a row via a query — the arrows navigate the menu.
          if (boundedActive === null && trigger.query.length === 0) {
            setDismissedStart(trigger.start);
            return false;
          }
          e.preventDefault();
          if (e.key === 'ArrowDown') {
            setActiveIndex(boundedActive === null ? 0 : (boundedActive + 1) % items.length);
          } else {
            setActiveIndex(
              boundedActive === null
                ? items.length - 1
                : (boundedActive - 1 + items.length) % items.length,
            );
          }
          return true;
        case 'Enter':
        case 'Tab':
          // NO row active means these keys were NOT aimed at the menu:
          // Enter stays a newline, Tab still leaves the field. This is the
          // proven regression ("This costs $" + Enter); never consume here.
          if (boundedActive === null) return false;
          e.preventDefault();
          select(boundedActive);
          return true;
        case 'Escape':
          // Only consume Escape when the user engaged with the menu (typed a
          // query or activated a row). A bare-trigger menu the user ignored
          // must not cost an extra Escape on the way to closing the composer.
          if (boundedActive === null && trigger.query.length === 0) return false;
          e.preventDefault();
          e.stopPropagation();
          setActiveIndex(null);
          setDismissedStart(trigger.start);
          return true;
        default:
          return false;
      }
    },
    [boundedActive, items.length, open, select, trigger],
  );

  const humanOnlyReferences = useMemo(
    () => (enabled ? extractSkillReferences(text, catalog).filter((s) => s.humanOnly) : []),
    [enabled, text, catalog],
  );

  const referenceTokens = useMemo(
    () => (enabled ? findSkillReferenceTokens(text, catalog) : []),
    [enabled, text, catalog],
  );

  return {
    menu: open ? { items, activeIndex: boundedActive, query: trigger.query } : null,
    onKeyDown,
    onSelect: readCaret,
    select,
    humanOnlyReferences,
    referenceTokens,
  };
}
