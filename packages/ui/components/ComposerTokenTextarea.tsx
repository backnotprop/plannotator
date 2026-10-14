/**
 * The comment composer's textarea with its token highlight layer (skill
 * references, host `@` mentions), moved out of CommentPopover so a host can
 * put the same field in its own composer (the Plannotator Inbox's reply box
 * and New message). CommentPopover renders it with every default, so its
 * markup is unchanged.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SkillReferenceToken } from '../utils/skillReferences';
import {
  mentionTokenRanges,
  mergeTokenRanges,
  skillTokenRanges,
  type ComposerTokenRange,
} from '../utils/composerTokens';
import type { MentionPerson } from '../utils/mentions';

/** Classes shared by the textarea and its highlight mirror — font, size,
 * and box metrics MUST stay identical or the overlay drifts out of alignment. */
export const COMPOSER_TEXT_CLASSES = 'w-full bg-transparent text-sm px-1 py-0.5';

/** Per-composer memo for the overlay gutter sync below. */
interface OverlayGutterState {
  /** The overlay the applied value belongs to (a remount invalidates it). */
  overlay: HTMLElement | null;
  /** Last `offsetWidth - clientWidth` seen on the textarea. */
  raw: number;
  /** Extra right padding currently written inline on the overlay, in px. */
  applied: number;
}

const cssPx = (value: string): number => {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Keep the mirror's text column exactly as wide as the textarea's (#1525).
 *
 * A layout-consuming vertical scrollbar (Windows/Linux classic scrollbars; the
 * app's `scrollbar-width: thin` makes them ~12px) narrows the textarea's
 * content box once the composer hits its max height — but the overlay is
 * `overflow: hidden` and keeps its full width, so from the first line that
 * wraps differently the painted glyphs drift away from the native caret, which
 * is the one thing the textarea itself still draws. `scrollbar-gutter: stable`
 * cannot fix this: it is ignored on an `overflow: hidden` box. Mirroring the
 * measured scrollbar width onto the overlay's right padding makes both boxes
 * wrap identically again (and stops the overlay painting under the scrollbar).
 *
 * Overlay scrollbars (macOS, iOS, any touch surface) consume no layout, so the
 * measured width is 0 — and then this writes NOTHING at all, leaving the
 * class-driven padding untouched exactly as before the fix.
 */
function syncOverlayGutter(
  el: HTMLTextAreaElement,
  overlay: HTMLElement,
  state: OverlayGutterState,
  raw: number,
): void {
  // Nothing measurable changed since the last sync — the common case.
  if (overlay === state.overlay && raw === state.raw) return;
  state.overlay = overlay;
  state.raw = raw;

  const clear = () => {
    if (state.applied === 0) return; // never wrote anything; leave the DOM alone
    overlay.style.removeProperty('padding-right');
    state.applied = 0;
  };

  const style = getComputedStyle(el);
  // `offsetWidth - clientWidth` is scrollbar + left/right borders. The borders
  // are shared with the overlay (both boxes are border-box), so only the
  // scrollbar part is the extra gutter the mirror is missing.
  const borders = cssPx(style.borderLeftWidth) + cssPx(style.borderRightWidth);
  const scrollbar = Math.max(0, raw - borders);
  if (scrollbar === 0) {
    clear();
    return;
  }
  // Base padding is read from the textarea (never the overlay, whose computed
  // value may already include a gutter we wrote), so the two can never drift
  // apart if COMPOSER_TEXT_CLASSES changes.
  const base = parseFloat(style.paddingRight);
  if (!Number.isFinite(base)) {
    clear(); // unmeasurable: fall back to the pre-fix behavior
    return;
  }
  overlay.style.paddingRight = `${base + scrollbar}px`;
  state.applied = scrollbar;
}

/**
 * The default chip look: the theme's primary at a wash, one shade stronger
 * than a skill reference's so the two token kinds in one overlay read as
 * siblings rather than the same thing. Deliberately no ring: every class here
 * is one the package already emitted, so a host build's CSS (and the portable
 * guide viewer's) is byte-identical to 0.43.2. A host that wants a pill adds
 * `box-shadow: 0 0 0 Npx <background>` through `tokenClassName` — paint, not
 * layout, per the metric rule above.
 */
const MENTION_CHIP_CLASSES = 'text-primary bg-primary/15 rounded-[3px]';

/**
 * One token's span in the highlight overlay.
 *
 * METRIC RULE, load-bearing for every token kind: a span may change COLOR,
 * BACKGROUND, BORDER-RADIUS, BOX-SHADOW and TEXT-DECORATION only. Anything
 * that moves a glyph — padding, margin, border width, font-weight,
 * letter-spacing, font-size — would shift the overlay's text off the
 * textarea's own layout and drift the caret away from the painted glyphs. A
 * pill's breathing room is faked with a paint-only `box-shadow` ring in the
 * chip's own background color.
 */
function renderTokenSpan(
  range: ComposerTokenRange,
  text: string,
  mentionTokenClassName?: string,
): React.ReactNode {
  if (range.kind === 'mention') {
    // `data-mention-token` / `data-mention-kind` are the host's styling hook;
    // `tokenClassName` is appended verbatim and is the host's to keep
    // metric-safe (see the rule above).
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
  // Human-only tokens carry a quiet dotted underline as their inline marker
  // (text-decoration never affects glyph layout, so overlay alignment is
  // safe). The accessible explanation lives in HumanOnlySkillNotice below
  // the textarea — this overlay is aria-hidden.
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

/** The mention half of the highlight layer. Null → no mention source at all. */
export interface ComposerMentionChips {
  /** The people whose `@Label` token still survives in the text. */
  readonly people: readonly MentionPerson[];
  /** Host class appended to each chip (see `MentionSource.tokenClassName`). */
  readonly tokenClassName?: string;
}

/** A host's extra classes, appended after a space; nothing at all when absent (the default markup is unchanged). */
const extra = (className: string | undefined): string => (className ? ` ${className}` : '');

export interface ComposerTokenTextareaProps {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Caret observer (skill autocomplete). */
  onSelectCaret: () => void;
  placeholder: string;
  /** Mode-specific min/max height classes. */
  sizeClassName: string;
  textareaRef: (el: HTMLTextAreaElement | null) => void;
  /** Positioned skill-reference occurrences to highlight. */
  tokens: SkillReferenceToken[];
  /** Off → no skill-reference contribution to the highlight layer. */
  skillReferences: boolean;
  /**
   * The mention contribution, or null with no `mentionSource`. Present (even
   * with nobody tagged yet) it turns the overlay on, so the first pick paints
   * a chip without swapping the textarea for a different element.
   */
  mentionChips: ComposerMentionChips | null;
  /** ARIA relationship to the skill-reference listbox. */
  listboxId: string;
  listboxOpen: boolean;
  activeOptionId?: string;
  /**
   * Font, size and box classes shared by the textarea and its mirror; they
   * MUST be the same on both or the overlay drifts. Default:
   * `COMPOSER_TEXT_CLASSES` (the comment composer's).
   */
  textClassName?: string;
  /** Extra classes on the textarea only (a host's own hook). */
  inputClassName?: string;
  /** Extra classes on the mirror only (a host that keeps its metrics in its own class). */
  mirrorClassName?: string;
  /**
   * Further textarea attributes (`aria-label`, `aria-describedby`, `rows`, …).
   * An `aria-label` here replaces the default, the placeholder.
   */
  inputProps?: Omit<
    React.TextareaHTMLAttributes<HTMLTextAreaElement>,
    'value' | 'onChange' | 'onKeyDown' | 'onSelect' | 'onScroll' | 'className' | 'placeholder'
  >;
}

/**
 * The composer's textarea. With NEITHER token source active this is exactly
 * the pre-feature `<textarea>`; with either one on, its tokens are painted by
 * a mirrored, aria-hidden overlay rendered BEHIND a transparent-text textarea
 * (a textarea cannot style substrings). ONE overlay serves both sources: two
 * mirrored layers could never stay pixel-aligned with each other, and only
 * one of them could own the scroll sync. The overlay shares the exact
 * font/padding/wrapping metrics and mirrors scroll position, and token spans
 * obey the metric rule on `renderTokenSpan` (paint only, never layout), so
 * the glyphs the browser lays out in the textarea and the glyphs the overlay
 * paints coincide. During IME composition the overlay hides and the textarea
 * text becomes visible again (`.pn-ref-composing`), keeping native
 * composition rendering (underlines, candidate highlights) intact.
 */
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
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [composing, setComposing] = useState(false);
  const gutterRef = useRef<OverlayGutterState>({ overlay: null, raw: 0, applied: 0 });

  const syncScroll = useCallback((el: HTMLTextAreaElement) => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    // Reads before writes so a sync costs at most one forced layout.
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

  // The overlay exists while EITHER source is active. `mentionChips` turns it
  // on for the whole life of a mention composer, not only once somebody is
  // tagged, so a pick never swaps the textarea element under the caret.
  const mentionPeople = mentionChips?.people;
  const highlight = skillReferences || mentionChips !== null;

  // The one list of spans the overlay paints, from every active source.
  // Skill references are the earlier group, so they win a byte both claim.
  const ranges = useMemo(
    () =>
      mergeTokenRanges(value, [
        skillReferences ? skillTokenRanges(tokens) : [],
        mentionPeople ? mentionTokenRanges(value, mentionPeople) : [],
      ]),
    [value, tokens, skillReferences, mentionPeople],
  );

  // Keep the mirror aligned when the value changes without a scroll event
  // (e.g. programmatic insertion moving the caret into a scrolled region).
  useEffect(() => {
    if (innerRef.current) syncScroll(innerRef.current);
  }, [value, syncScroll]);

  // `syncScroll` otherwise only runs on scroll and on value change, so a
  // window/panel resize that grows or drops the textarea's scrollbar without a
  // keystroke would leave the gutter stale until the next one.
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
        // Absent any open menu these are all undefined, so the plain textarea
        // renders exactly the attributes it always did.
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
  let pos = 0;
  for (const range of ranges) {
    if (range.start > pos) segments.push(value.slice(pos, range.start));
    segments.push(
      renderTokenSpan(range, value.slice(range.start, range.end), mentionChips?.tokenClassName),
    );
    pos = range.end;
  }
  segments.push(value.slice(pos));

  return (
    <div className="relative">
      <div
        ref={overlayRef}
        aria-hidden="true"
        // Names the SKILL-reference layer, so a skill composer's overlay is
        // byte-identical to the one it rendered before mentions existed; a
        // mentions-only overlay is found by its mirror attribute below.
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
