import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { fetchSkillCatalog, getCachedSkillCatalog, onSkillCatalogReload } from '../utils/skillCatalog';

export interface SkillReferenceMenuState {
  items: SkillCatalogEntry[];
  activeIndex: number | null;
  query: string;
}

export interface UseSkillReferenceAutocompleteResult {
  menu: SkillReferenceMenuState | null;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  onSelect: () => void;
  select: (index: number) => void;
  humanOnlyReferences: SkillCatalogEntry[];
  referenceTokens: SkillReferenceToken[];
}

export function useSkillReferenceAutocomplete(options: {
  text: string;
  setText: (text: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  enabled: boolean;
  bareEscapeDismisses?: boolean;
  catalogFilter?: (entry: SkillCatalogEntry) => boolean;
  commands?: readonly SkillCatalogEntry[];
  onCommand?: (command: SkillCatalogEntry, text: string) => void;
  hostRowsFirst?: boolean;
}): UseSkillReferenceAutocompleteResult {
  const { text, setText, textareaRef, enabled, bareEscapeDismisses = false, catalogFilter, commands, onCommand, hostRowsFirst = false } = options;
  const [fullCatalog, setCatalog] = useState<SkillCatalogEntry[]>(() =>
    enabled ? getCachedSkillCatalog() : [],
  );
  const catalog = useMemo(() => (catalogFilter ? fullCatalog.filter(catalogFilter) : fullCatalog), [fullCatalog, catalogFilter]);
  const [caret, setCaret] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [dismissedStart, setDismissedStart] = useState<number | null>(null);

  const [reloads, setReloads] = useState(0);
  useEffect(() => (enabled ? onSkillCatalogReload(() => setReloads((n) => n + 1)) : undefined), [enabled]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetchSkillCatalog().then((skills) => {
      if (!cancelled) setCatalog(skills);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, reloads]);

  const trigger: SkillTriggerContext | null = useMemo(() => {
    if (!enabled || (catalog.length === 0 && !commands?.length) || caret === null) return null;
    return findSkillTrigger(text, caret);
  }, [enabled, catalog, commands, text, caret]);

  const slashList = useMemo(() => {
    const offered = commands?.filter((command) => !catalog.some((skill) => skill.name === command.name)) ?? [];
    if (offered.length === 0) return catalog;
    const lead = catalog.findIndex((skill) => skill.root !== 'plannotator');
    const at = lead === -1 ? catalog.length : lead;
    return [...catalog.slice(0, at), ...offered, ...catalog.slice(at)];
  }, [catalog, commands]);

  const items = useMemo(() => {
    if (!trigger) return [];
    const found = filterSkillCatalog(trigger.trigger === '/' ? slashList : catalog, trigger.query);
    return hostRowsFirst ? [...found.filter((row) => row.root === 'plannotator'), ...found.filter((row) => row.root !== 'plannotator')] : found;
  }, [catalog, hostRowsFirst, slashList, trigger]);

  const open = trigger !== null && items.length > 0 && trigger.start !== dismissedStart;

  const lastTriggerStart = useRef<number | null>(null);
  useEffect(() => {
    const start = trigger?.start ?? null;
    if (start !== lastTriggerStart.current) {
      lastTriggerStart.current = start;
      setDismissedStart(null);
    }
  }, [trigger]);

  const triggerStart = trigger?.start ?? null;
  const triggerQuery = trigger?.query ?? null;
  useEffect(() => {
    setActiveIndex(null);
  }, [triggerStart, triggerQuery]);

  const boundedActive =
    activeIndex !== null && activeIndex >= 0 && activeIndex < items.length ? activeIndex : null;

  const readCaret = useCallback(() => {
    const el = textareaRef.current;
    setCaret(el ? el.selectionStart : null);
  }, [textareaRef]);

  const pendingCaret = useRef<{ el: HTMLTextAreaElement; text: string; caret: number } | null>(null);
  useLayoutEffect(() => {
    const pending = pendingCaret.current;
    if (!pending || pending.el.value !== pending.text) return;
    pendingCaret.current = null;
    if (!pending.el.isConnected) return;
    pending.el.focus();
    pending.el.setSelectionRange(pending.caret, pending.caret);
  });

  const select = useCallback(
    (index: number) => {
      const el = textareaRef.current;
      if (!trigger || !el) return;
      const item = items[index];
      if (!item) return;
      if (commands?.includes(item)) {
        const rest = text.slice(0, trigger.start) + text.slice(el.selectionStart);
        setText(rest);
        setCaret(trigger.start);
        setActiveIndex(null);
        setDismissedStart(trigger.start);
        onCommand?.(item, rest);
        return;
      }
      const result = insertSkillReference(text, el.selectionStart, trigger, item);
      setText(result.text);
      setCaret(result.caret);
      setActiveIndex(null);
      setDismissedStart(trigger.start);
      const pending = { el, text: result.text, caret: result.caret };
      pendingCaret.current = pending;
      setTimeout(() => {
        if (pendingCaret.current !== pending) return;
        pendingCaret.current = null;
        if (!el.isConnected || el.value !== result.text) return;
        el.focus();
        el.setSelectionRange(result.caret, result.caret);
      }, 0);
    },
    [commands, items, onCommand, setText, text, textareaRef, trigger],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open) return false;
      if (e.nativeEvent.isComposing) return false;
      if (e.metaKey || e.ctrlKey || e.altKey) return false;
      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowUp':
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
          if (boundedActive === null) return false;
          e.preventDefault();
          select(boundedActive);
          return true;
        case 'Escape':
          if (!bareEscapeDismisses && boundedActive === null && trigger.query.length === 0) return false;
          e.preventDefault();
          e.stopPropagation();
          setActiveIndex(null);
          setDismissedStart(trigger.start);
          return true;
        default:
          return false;
      }
    },
    [bareEscapeDismisses, boundedActive, items.length, open, select, trigger],
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
