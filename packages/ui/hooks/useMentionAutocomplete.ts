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
  emptyNotice: string | null;
  heading: string | null;
  activeIndex: number | null;
  anchor: MentionAnchor | null;
  query: string;
}

export interface UseMentionAutocompleteResult {
  menu: MentionMenuState | null;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  onSelect: () => void;
  select: (index: number) => void;
  mentionIds: readonly string[];
  mentions: readonly MentionPerson[];
}

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
  const [dismissedStart, setDismissedStart] = useState<number | null>(null);

  const trigger: MentionTrigger | null = useMemo(() => {
    if (!enabled || caret === null) return null;
    return mentionTrigger(text, caret);
  }, [enabled, text, caret]);

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
  }, [mentionsKey, onMentionsChange]);

  const items = useMemo(
    () => (source && trigger ? mentionMatches(source.people, trigger, taggedIds, source.kinds, source.matchDetail ?? true) : []),
    [source, trigger, taggedIds],
  );

  const emptyNotice = source?.emptyNotice ?? null;
  const heading = source?.heading ?? null;
  const open =
    trigger !== null
    && trigger.from !== dismissedStart
    && (items.length > 0 || !!emptyNotice);

  const triggerStart = trigger?.from ?? null;
  const lastTriggerStart = useRef<number | null>(null);
  useEffect(() => {
    if (triggerStart !== lastTriggerStart.current) {
      lastTriggerStart.current = triggerStart;
      setDismissedStart(null);
    }
  }, [triggerStart]);

  const triggerQuery = trigger?.query ?? null;
  useEffect(() => {
    setActiveIndex(null);
  }, [triggerStart, triggerQuery]);

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
      if (e.nativeEvent.isComposing) return false;
      if (e.metaKey || e.ctrlKey || e.altKey) return false;
      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowUp':
          if (items.length === 0) return false;
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
