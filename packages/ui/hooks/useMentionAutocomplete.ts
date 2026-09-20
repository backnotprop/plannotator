import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import {
  applyMentionPick,
  mentionMatches,
  mentionTrigger,
  survivingMentions,
  type MentionPerson,
  type MentionSource,
  type MentionTrigger,
} from '../utils/mentions';
import { mentionAnchorOf, type MentionAnchor } from '../components/MentionPicker';

export interface MentionMenuState {
  items: readonly MentionPerson[];
  /** Shown as one non-selectable row when `items` is empty. */
  emptyNotice: string | null;
  heading: string | null;
  /** Explicitly activated row, or null — the menu opens with NOTHING active. */
  activeIndex: number | null;
  /** Measured textarea rect the portaled picker is placed from. */
  anchor: MentionAnchor | null;
  query: string;
}

export interface UseMentionAutocompleteResult {
  /** Open menu state, or null. Render MentionPicker from this. */
  menu: MentionMenuState | null;
  /** Call in the textarea's onKeyDown; true means the event was consumed. */
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Call from the textarea's onSelect and onChange (every caret move + input). */
  onSelect: () => void;
  /** Insert the given menu item at the active trigger. */
  select: (index: number) => void;
  /** The ids whose readable token still survives in the text. */
  mentionIds: readonly string[];
  /**
   * The same survivors as people, for a caller that needs their labels — the
   * composer paints each surviving token as a chip. Frozen-empty with no
   * source, the same treatment `mentionIds` gets.
   */
  mentions: readonly MentionPerson[];
}

/**
 * `@` mention autocomplete for a comment textarea, driven entirely by a
 * host-supplied `MentionSource`. With no source every path here is inert:
 * no listener is registered, no menu state is ever open, `mentionIds` stays
 * the same frozen empty array, and the composer renders and behaves exactly
 * as it did before the prop existed.
 *
 * NO-PRESELECTION INVARIANT (shared with `useSkillReferenceAutocomplete`):
 * the menu opens with no row active, and while no row is active Enter and
 * Tab behave exactly as if the menu were not open — a body that ends
 * "ping @" plus Enter is still a newline. A row becomes active only through
 * explicit keyboard navigation (ArrowDown from none lands on the FIRST row,
 * ArrowUp from none on the LAST) or a pointer click, which inserts directly.
 *
 * DELIBERATE DIFFERENCE from the `/` and `$` skill trigger: the arrows engage
 * this menu even on a BARE trigger (`@` with no query typed). `$` and `/` are
 * ordinary prose characters, so their menu must yield the arrows back to
 * caret navigation; `@` at a word boundary is an unambiguous tag gesture, and
 * typing `@` then ArrowDown is how the host's own reply box already behaves.
 * Escape closes the menu whenever it is visible, for the same reason.
 */
const NO_IDS: readonly string[] = Object.freeze([]);
const NO_PEOPLE: readonly MentionPerson[] = Object.freeze([]);

export function useMentionAutocomplete(options: {
  text: string;
  setText: (text: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  source?: MentionSource;
}): UseMentionAutocompleteResult {
  const { text, setText, textareaRef, source } = options;
  const enabled = !!source;
  const [caret, setCaret] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [tagged, setTagged] = useState<readonly MentionPerson[]>(NO_PEOPLE);
  const [anchor, setAnchor] = useState<MentionAnchor | null>(null);
  // Escape dismisses the menu for the trigger it was open on; the same trigger
  // does not reopen until the caret leaves it.
  const [dismissedStart, setDismissedStart] = useState<number | null>(null);

  const trigger: MentionTrigger | null = useMemo(() => {
    if (!enabled || caret === null) return null;
    return mentionTrigger(text, caret);
  }, [enabled, text, caret]);

  // A token the author deleted stops being a tag, so the body and the
  // reported ids never disagree about who was named.
  const survivors = useMemo(() => survivingMentions(text, tagged), [text, tagged]);
  useEffect(() => {
    if (survivors.length !== tagged.length) setTagged(survivors);
  }, [survivors, tagged]);

  const taggedIds = useMemo(() => new Set(survivors.map((p) => p.id)), [survivors]);
  const mentionIds = useMemo(
    () => (enabled ? survivors.map((p) => p.id) : NO_IDS),
    [enabled, survivors],
  );
  const mentions = enabled ? survivors : NO_PEOPLE;

  const onMentionsChange = source?.onMentionsChange;
  const mentionsKey = mentionIds.join('\u0000');
  const lastReported = useRef<string | null>(null);
  useEffect(() => {
    if (!onMentionsChange) return;
    if (lastReported.current === mentionsKey) return;
    lastReported.current = mentionsKey;
    onMentionsChange(mentionIds);
    // mentionIds is keyed by mentionsKey; re-running on identity alone would
    // report the same ids on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentionsKey, onMentionsChange]);

  const items = useMemo(
    () => (source && trigger ? mentionMatches(source.people, trigger, taggedIds) : []),
    [source, trigger, taggedIds],
  );

  const emptyNotice = source?.emptyNotice ?? null;
  const heading = source?.heading ?? null;
  const open =
    trigger !== null
    && trigger.from !== dismissedStart
    && (items.length > 0 || !!emptyNotice);

  // A new trigger start clears the dismissal memory.
  const triggerStart = trigger?.from ?? null;
  const lastTriggerStart = useRef<number | null>(null);
  useEffect(() => {
    if (triggerStart !== lastTriggerStart.current) {
      lastTriggerStart.current = triggerStart;
      setDismissedStart(null);
    }
  }, [triggerStart]);

  // Any trigger change — a new one, or more typing re-filtering the same one —
  // disarms the active row, so an activation always refers to the exact list
  // the user was looking at.
  const triggerQuery = trigger?.query ?? null;
  useEffect(() => {
    setActiveIndex(null);
  }, [triggerStart, triggerQuery]);

  // Measure the composer while the menu is open (and follow scroll/resize).
  useEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    const measure = () => setAnchor(mentionAnchorOf(textareaRef.current));
    measure();
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open, textareaRef, triggerStart, triggerQuery]);

  const boundedActive =
    activeIndex !== null && activeIndex >= 0 && activeIndex < items.length ? activeIndex : null;

  const readCaret = useCallback(() => {
    if (!enabled) return;
    const el = textareaRef.current;
    setCaret(el ? el.selectionStart : null);
  }, [enabled, textareaRef]);

  const select = useCallback(
    (index: number) => {
      const el = textareaRef.current;
      if (!source || !trigger) return;
      const person = items[index];
      if (!person) return;
      if (person.canOpen === false && source.onPickBlocked) {
        // Nothing is inserted: the host owns the no-access affordance.
        source.onPickBlocked(person);
        setActiveIndex(null);
        setDismissedStart(trigger.from);
        return;
      }
      const result = applyMentionPick(text, trigger, person);
      setText(result.text);
      setCaret(result.caret);
      setTagged((prev) => (prev.some((p) => p.id === person.id) ? prev : [...prev, person]));
      setActiveIndex(null);
      // Close deterministically: the DOM caret only moves in the timer below,
      // and React's select plugin can re-read the STALE caret before then,
      // transiently reopening the menu on the just-replaced query.
      setDismissedStart(trigger.from);
      setTimeout(() => {
        if (!el || !el.isConnected) return;
        el.focus();
        el.setSelectionRange(result.caret, result.caret);
      }, 0);
    },
    [items, setText, source, text, textareaRef, trigger],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open || !trigger) return false;
      // Never consume keys mid-composition: for Pinyin, Telex and friends the
      // composition buffer is ASCII, so Enter can mean "commit this candidate".
      if (e.nativeEvent.isComposing) return false;
      if (e.metaKey || e.ctrlKey || e.altKey) return false;
      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowUp':
          if (items.length === 0) return false; // the empty-notice row is not navigable
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
          // NO row active means these keys were NOT aimed at the menu: Enter
          // stays a newline, Tab still leaves the field.
          if (boundedActive === null) return false;
          e.preventDefault();
          select(boundedActive);
          return true;
        case 'Escape':
          e.preventDefault();
          e.stopPropagation();
          setActiveIndex(null);
          setDismissedStart(trigger.from);
          return true;
        default:
          return false;
      }
    },
    [boundedActive, items.length, open, select, trigger],
  );

  return {
    menu: open && trigger
      ? { items, emptyNotice, heading, activeIndex: boundedActive, anchor, query: trigger.query }
      : null,
    onKeyDown,
    onSelect: readCaret,
    select,
    mentionIds,
    mentions,
  };
}
