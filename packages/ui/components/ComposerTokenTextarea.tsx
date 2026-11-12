import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SkillReferenceToken } from '../utils/skillReferences';
import {
  mentionTokenRanges,
  mergeTokenRanges,
  skillTokenRanges,
  type ComposerTokenRange,
} from '../utils/composerTokens';
import type { MentionPerson } from '../utils/mentions';

export const COMPOSER_TEXT_CLASSES = 'w-full bg-transparent text-sm px-1 py-0.5';

interface OverlayGutterState {
  overlay: HTMLElement | null;
  raw: number;
  applied: number;
}

const cssPx = (value: string): number => {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};

function syncOverlayGutter(
  el: HTMLTextAreaElement,
  overlay: HTMLElement,
  state: OverlayGutterState,
  raw: number,
): void {
  if (overlay === state.overlay && raw === state.raw) return;
  state.overlay = overlay;
  state.raw = raw;

  const clear = () => {
    if (state.applied === 0) return;
    overlay.style.removeProperty('padding-right');
    state.applied = 0;
  };

  const style = getComputedStyle(el);
  const borders = cssPx(style.borderLeftWidth) + cssPx(style.borderRightWidth);
  const scrollbar = Math.max(0, raw - borders);
  if (scrollbar === 0) {
    clear();
    return;
  }
  const base = parseFloat(style.paddingRight);
  if (!Number.isFinite(base)) {
    clear();
    return;
  }
  overlay.style.paddingRight = `${base + scrollbar}px`;
  state.applied = scrollbar;
}

const MENTION_CHIP_CLASSES = 'text-primary bg-primary/15 rounded-[3px]';

function renderTokenSpan(
  range: ComposerTokenRange,
  text: string,
  mentionTokenClassName?: string,
): React.ReactNode {
  if (range.kind === 'mention') {
    return (
      <span
        key={`mention-${range.start}`}
        data-mention-token={range.person.id}
        data-mention-kind={range.person.kind}
        className={`${MENTION_CHIP_CLASSES}${
          mentionTokenClassName ? ` ${mentionTokenClassName}` : ''
        }`}
      >
        {text}
      </span>
    );
  }
  return (
    <span
      key={`skill-${range.start}`}
      data-skill-ref-token={range.skill.entry.name}
      data-skill-ref-human-only={range.skill.entry.humanOnly ? 'true' : undefined}
      className={`text-primary bg-primary/10 rounded-[3px] ${
        range.skill.entry.humanOnly
          ? 'underline decoration-dotted decoration-primary/60 underline-offset-2'
          : ''
      }`}
    >
      {text}
    </span>
  );
}

export interface ComposerMentionChips {
  readonly people: readonly MentionPerson[];
  readonly tokenClassName?: string;
}

const extra = (className: string | undefined): string => (className ? ` ${className}` : '');

export interface ComposerTokenTextareaProps {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSelectCaret: () => void;
  placeholder: string;
  sizeClassName: string;
  textareaRef: (el: HTMLTextAreaElement | null) => void;
  tokens: SkillReferenceToken[];
  skillReferences: boolean;
  mentionChips: ComposerMentionChips | null;
  listboxId: string;
  listboxOpen: boolean;
  activeOptionId?: string;
  textClassName?: string;
  inputClassName?: string;
  mirrorClassName?: string;
  inputProps?: Omit<
    React.TextareaHTMLAttributes<HTMLTextAreaElement>,
    'value' | 'onChange' | 'onKeyDown' | 'onSelect' | 'onScroll' | 'className' | 'placeholder'
  >;
  mirrorPaint?: ComposerMirrorPaint;
}

export interface ComposerMirrorPaint {
  at?: number;
  node?: React.ReactNode;
  wash?: { start: number; end: number; className: string };
}

export const ComposerTokenTextarea: React.FC<ComposerTokenTextareaProps> = ({
  value,
  onChange,
  onKeyDown,
  onSelectCaret,
  placeholder,
  sizeClassName,
  textareaRef,
  tokens,
  skillReferences,
  mentionChips,
  listboxId,
  listboxOpen,
  activeOptionId,
  textClassName = COMPOSER_TEXT_CLASSES,
  inputClassName,
  mirrorClassName,
  inputProps,
  mirrorPaint,
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [composing, setComposing] = useState(false);
  const gutterRef = useRef<OverlayGutterState>({ overlay: null, raw: 0, applied: 0 });

  const syncScroll = useCallback((el: HTMLTextAreaElement) => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const { scrollTop, scrollLeft } = el;
    const raw = el.offsetWidth - el.clientWidth;
    overlay.scrollTop = scrollTop;
    overlay.scrollLeft = scrollLeft;
    syncOverlayGutter(el, overlay, gutterRef.current, raw);
  }, []);

  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const attachRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      innerRef.current = el;
      textareaRef(el);
    },
    [textareaRef],
  );

  const mentionPeople = mentionChips?.people;
  const highlight = skillReferences || mentionChips !== null;

  const ranges = useMemo(
    () =>
      mergeTokenRanges(value, [
        skillReferences ? skillTokenRanges(tokens) : [],
        mentionPeople ? mentionTokenRanges(value, mentionPeople) : [],
      ]),
    [value, tokens, skillReferences, mentionPeople],
  );

  useEffect(() => {
    if (innerRef.current) syncScroll(innerRef.current);
  }, [value, syncScroll]);

  useEffect(() => {
    const el = innerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (innerRef.current) syncScroll(innerRef.current);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [highlight, syncScroll]);

  if (!highlight) {
    return (
      <textarea
        data-pn-mobile-editable="true"
        aria-autocomplete={listboxOpen ? 'list' : undefined}
        aria-controls={listboxOpen ? listboxId : undefined}
        aria-activedescendant={activeOptionId}
        {...inputProps}
        ref={attachRef}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onSelect={onSelectCaret}
        placeholder={placeholder}
        className={`${textClassName} placeholder:text-muted-foreground resize-none focus:outline-none ${sizeClassName}${extra(inputClassName)}`}
        style={{ fieldSizing: 'content' } as React.CSSProperties}
      />
    );
  }

  const segments: React.ReactNode[] = [];
  let paintDrawn = false;
  const pushPlain = (start: number, end: number) => {
    if (!mirrorPaint) {
      segments.push(value.slice(start, end));
      return;
    }
    const { at, node, wash } = mirrorPaint;
    const cuts = [start, end, ...[at, wash?.start, wash?.end].filter((cut): cut is number => cut !== undefined && cut > start && cut < end)].sort((a, b) => a - b);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const from = cuts[i]!;
      const to = cuts[i + 1]!;
      if (!paintDrawn && at !== undefined && from >= at) {
        paintDrawn = true;
        segments.push(<React.Fragment key="mirror-paint">{node}</React.Fragment>);
      }
      if (from === to) continue;
      const text = value.slice(from, to);
      segments.push(
        wash && from >= wash.start && to <= wash.end ? (
          <mark key={`mirror-wash-${from}`} className={wash.className}>
            {text}
          </mark>
        ) : (
          text
        ),
      );
    }
  };
  let pos = 0;
  for (const range of ranges) {
    if (range.start > pos) pushPlain(pos, range.start);
    segments.push(
      renderTokenSpan(range, value.slice(range.start, range.end), mentionChips?.tokenClassName),
    );
    pos = range.end;
  }
  pushPlain(pos, value.length);
  if (mirrorPaint?.at !== undefined && !paintDrawn) segments.push(<React.Fragment key="mirror-paint">{mirrorPaint.node}</React.Fragment>);

  return (
    <div className="relative">
      <div
        ref={overlayRef}
        aria-hidden="true"
        data-skill-ref-overlay={skillReferences ? 'true' : undefined}
        data-pn-mobile-editable-mirror="true"
        className={`${textClassName} ${sizeClassName} pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words${extra(mirrorClassName)}`}
        style={composing ? { visibility: 'hidden' } : undefined}
      >
        {segments}
        {'\n'}
      </div>
      <textarea
        data-pn-mobile-editable="true"
        aria-label={placeholder}
        {...inputProps}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-controls={listboxOpen ? listboxId : undefined}
        aria-owns={listboxOpen ? listboxId : undefined}
        aria-activedescendant={activeOptionId}
        ref={attachRef}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onSelect={onSelectCaret}
        onScroll={(e) => syncScroll(e.currentTarget)}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        placeholder={placeholder}
        className={`${textClassName} placeholder:text-muted-foreground resize-none focus:outline-none relative pn-ref-input ${
          composing ? 'pn-ref-composing' : ''
        } ${sizeClassName}${extra(inputClassName)}`}
        style={{ fieldSizing: 'content' } as React.CSSProperties}
      />
    </div>
  );
};
