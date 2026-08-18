import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, Copy, Search } from 'lucide-react';
import { CommentPopover, type CommentTargetChip } from '@plannotator/ui/components/CommentPopover';
import type { CallFlowAnnotationTarget } from '@plannotator/ui/types';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import {
  annotationTargetForCallFlowRawLine,
  findCallFlowRawMatches,
  getCallFlowRawLines,
  type CallFlowRawAnnotationTarget,
  type CallFlowRawLine,
} from '../utils/callFlowPresentation';
import { CallFlowSearchControls } from './CallFlowSearchControls';
import {
  useCallFlowFindShortcut,
  type CallFlowFindShortcutSurface,
} from '../hooks/useCallFlowFindShortcut';

/** One canonical raw CallDiff slice and its position in the complete response. */
export interface CallFlowRawSection {
  readonly key: string;
  readonly label?: string;
  readonly raw: string;
  readonly rawLineStart: number;
}

interface IndexedRawSection extends CallFlowRawSection {
  readonly lines: ReadonlyArray<{ readonly line: CallFlowRawLine; readonly lineIndex: number }>;
}

/** Searchable, annotatable raw CallDiff output shared by the Dock and file Lens. */
export function CallFlowRawView({
  sections,
  onAnnotateTargets,
  onAnnotationDraftChange,
  compact = false,
  findShortcutActive = false,
  findShortcutSurface = 'dock',
}: {
  readonly sections: readonly CallFlowRawSection[];
  readonly onAnnotateTargets: (
    targets: readonly CallFlowAnnotationTarget[],
    text: string,
  ) => boolean;
  readonly onAnnotationDraftChange?: (active: boolean) => void;
  readonly compact?: boolean;
  /** True only while this mounted renderer owns the foreground find shortcut. */
  readonly findShortcutActive?: boolean;
  /** Distinguishes a foreground Lens from a retained Dockview portal. */
  readonly findShortcutSurface?: CallFlowFindShortcutSurface;
}) {
  const indexedSections = useMemo<IndexedRawSection[]>(() => {
    let lineIndex = 0;
    return sections.map((section) => {
      const sectionLines = getCallFlowRawLines(section.raw, section.rawLineStart);
      const lines = sectionLines.map((line) => ({ line, lineIndex: lineIndex++ }));
      return { ...section, lines };
    });
  }, [sections]);
  const lines = useMemo(
    () => indexedSections.flatMap((section) => section.lines.map(({ line }) => line)),
    [indexedSections],
  );
  const annotationTargets = useMemo(
    () => lines.map(annotationTargetForCallFlowRawLine),
    [lines],
  );
  const copyValue = useMemo(() => sections.map((section) => section.raw).join('\n\n'), [sections]);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const selectSearchInputRef = useRef(false);
  const searchWasOpenRef = useRef(false);
  const rawPreRef = useRef<HTMLDivElement>(null);
  const rawInstanceId = useId();
  const [draftTargets, setDraftTargets] = useState<CallFlowRawAnnotationTarget[]>([]);
  const [refocusToken, setRefocusToken] = useState(0);
  const [activeLineIndex, setActiveLineIndex] = useState(0);
  const targetElements = useRef(new Map<string, HTMLButtonElement>());
  const selectedTargetKeys = useMemo(
    () => new Set(draftTargets.map((target) => target.treePath)),
    [draftTargets],
  );
  const anchorEl = draftTargets[0]
    ? targetElements.current.get(draftTargets[0].treePath)
    : undefined;
  const matches = useMemo(() => findCallFlowRawMatches(lines, query), [lines, query]);
  const matchesByLine = useMemo(() => {
    const byLine = new Map<number, Array<(typeof matches)[number] & { index: number }>>();
    matches.forEach((match, index) => {
      const lineMatches = byLine.get(match.lineIndex) ?? [];
      lineMatches.push({ ...match, index });
      byLine.set(match.lineIndex, lineMatches);
    });
    return byLine;
  }, [matches]);

  useEffect(() => () => {
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
  }, []);

  const openSearchFromShortcut = useCallback(() => {
    selectSearchInputRef.current = true;
    setSearchOpen(true);
  }, []);
  useCallFlowFindShortcut({
    active: findShortcutActive,
    surface: findShortcutSurface,
    searchOpen,
    inputRef: searchInputRef,
    openSearch: openSearchFromShortcut,
  });

  useEffect(() => {
    if (!searchOpen) {
      if (searchWasOpenRef.current) {
        searchWasOpenRef.current = false;
        searchTriggerRef.current?.focus();
      }
      return;
    }
    searchWasOpenRef.current = true;
    if (selectSearchInputRef.current) {
      selectSearchInputRef.current = false;
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
      return;
    }
    if (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: fine)').matches) {
      searchInputRef.current?.focus();
    }
  }, [searchOpen]);

  useEffect(() => {
    if (matches.length === 0) return;
    const match = rawPreRef.current?.querySelector<HTMLElement>(`[data-raw-match="${currentMatchIndex}"]`);
    match?.scrollIntoView?.({ block: 'nearest' });
  }, [currentMatchIndex, matches]);

  useEffect(() => {
    setActiveLineIndex(0);
  }, [copyValue]);

  const replaceDraft = (next: CallFlowRawAnnotationTarget[]) => {
    const wasActive = draftTargets.length > 0;
    const active = next.length > 0;
    setDraftTargets(next);
    if (wasActive !== active) onAnnotationDraftChange?.(active);
  };
  const closeSearch = () => {
    setSearchOpen(false);
    setQuery('');
    setCurrentMatchIndex(0);
  };
  const moveMatch = (direction: 1 | -1) => {
    if (matches.length === 0) return;
    setCurrentMatchIndex((index) => (index + direction + matches.length) % matches.length);
  };
  const updateQuery = (value: string) => {
    setQuery(value);
    setCurrentMatchIndex(0);
  };
  const copyRaw = async () => {
    const copied = await copyTextToClipboard(copyValue);
    setCopyState(copied ? 'copied' : 'error');
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    copyResetTimer.current = window.setTimeout(() => setCopyState('idle'), 1500);
  };
  const selectTarget = (
    target: CallFlowRawAnnotationTarget,
    anchor: HTMLButtonElement,
    extend: boolean,
  ) => {
    targetElements.current.set(target.treePath, anchor);
    if (!extend || draftTargets.length === 0) {
      replaceDraft([target]);
      return;
    }
    const existingIndex = draftTargets.findIndex((candidate) => candidate.treePath === target.treePath);
    replaceDraft(existingIndex === -1
      ? [...draftTargets, target]
      : draftTargets.filter((_, index) => index !== existingIndex));
    setRefocusToken((token) => token + 1);
  };
  const removeTarget = (chipKey: string) => {
    replaceDraft(draftTargets.filter((target) => `${rawInstanceId}:${target.treePath}` !== chipKey));
    setRefocusToken((token) => token + 1);
  };
  const targetChips = useMemo<CommentTargetChip[]>(() => draftTargets.map((target) => ({
    key: `${rawInstanceId}:${target.treePath}`,
    label: `Line ${target.rawLine}`,
    excerpt: target.label,
  })), [draftTargets, rawInstanceId]);
  const moveLineFocus = (lineIndex: number) => {
    const boundedIndex = Math.max(0, Math.min(lineIndex, annotationTargets.length - 1));
    const target = annotationTargets[boundedIndex];
    if (!target) return;
    setActiveLineIndex(boundedIndex);
    targetElements.current.get(target.treePath)?.focus();
  };

  const renderLine = (line: CallFlowRawLine, lineIndex: number) => {
    const lineMatches = matchesByLine.get(lineIndex);
    const content: React.ReactNode[] = [];
    if (!lineMatches || lineMatches.length === 0) {
      content.push(line.content);
    } else {
      let cursor = 0;
      lineMatches.forEach((match) => {
        content.push(line.content.slice(cursor, match.start));
        content.push(
          <mark
            className={match.index === currentMatchIndex ? 'call-flow-raw-match-current' : undefined}
            data-raw-match={match.index}
            key={`${match.start}:${match.end}`}
          >
            {line.content.slice(match.start, match.end)}
          </mark>,
        );
        cursor = match.end;
      });
      content.push(line.content.slice(cursor));
    }
    const target = annotationTargets[lineIndex];
    if (!target) return null;
    return (
      <button
        type="button"
        className={`call-flow-raw-line call-flow-raw-line-${line.kind}`}
        key={target.treePath}
        ref={(element) => {
          if (element) targetElements.current.set(target.treePath, element);
          else targetElements.current.delete(target.treePath);
        }}
        aria-label={`Raw line ${target.rawLine}, ${line.kind}: ${target.label}`}
        aria-pressed={selectedTargetKeys.has(target.treePath)}
        tabIndex={activeLineIndex === lineIndex ? 0 : -1}
        onFocus={() => setActiveLineIndex(lineIndex)}
        onKeyDown={(event) => {
          const nextIndex = event.key === 'ArrowDown'
            ? lineIndex + 1
            : event.key === 'ArrowUp'
              ? lineIndex - 1
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? annotationTargets.length - 1
                  : undefined;
          if (nextIndex === undefined) return;
          event.preventDefault();
          moveLineFocus(nextIndex);
        }}
        onClick={(event) => selectTarget(target, event.currentTarget, event.shiftKey)}
      >
        {content}
      </button>
    );
  };

  return (
    <section className={`call-flow-raw${compact ? ' call-flow-raw-compact' : ''}`} aria-label="Raw call diff">
      <div className="call-flow-raw-toolbar">
        {!compact && <span className="call-flow-raw-hint">Click a line to comment · Shift-click adds lines</span>}
        {searchOpen ? (
          <CallFlowSearchControls
            inputRef={searchInputRef}
            label="Search raw call diff"
            placeholder="Find in raw output"
            query={query}
            currentMatchIndex={currentMatchIndex}
            matchCount={matches.length}
            onQueryChange={updateQuery}
            onMoveMatch={moveMatch}
            onClose={closeSearch}
          />
        ) : (
          <button
            ref={searchTriggerRef}
            type="button"
            className="call-flow-icon-button"
            onClick={() => setSearchOpen(true)}
            aria-label="Search raw call diff"
            title="Search raw output"
          >
            <Search aria-hidden="true" size={14} />
          </button>
        )}
        <button type="button" onClick={() => void copyRaw()} aria-label="Copy raw call diff">
          {copyState === 'copied' ? <Check aria-hidden="true" size={14} /> : <Copy aria-hidden="true" size={14} />}
          {!compact && (copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Copy failed' : 'Copy')}
        </button>
      </div>
      <div ref={rawPreRef} className="call-flow-raw-sections">
        {indexedSections.map((section) => (
          <section className="call-flow-raw-section" key={section.key}>
            {section.label && <div className="call-flow-raw-section-title">{section.label}</div>}
            <pre><code>{section.lines.map(({ line, lineIndex }) => renderLine(line, lineIndex))}</code></pre>
          </section>
        ))}
      </div>
      {anchorEl && draftTargets.length > 0 && (
        <CommentPopover
          anchorEl={anchorEl}
          contextText={`Raw line ${draftTargets[0]?.rawLine}: ${draftTargets[0]?.label}`}
          isGlobal={false}
          allowImages={false}
          targetChips={targetChips}
          onRemoveTargetChip={removeTarget}
          refocusToken={refocusToken}
          captureStrayKeys
          onSubmit={(text) => {
            if (onAnnotateTargets(draftTargets, text)) replaceDraft([]);
          }}
          onClose={() => replaceDraft([])}
        />
      )}
      <span className="sr-only" aria-live="polite">
        {draftTargets.length > 0
          ? `${draftTargets.length} raw CallDiff ${draftTargets.length === 1 ? 'line' : 'lines'} selected.`
          : ''}
      </span>
    </section>
  );
}
