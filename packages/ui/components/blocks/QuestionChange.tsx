/**
 * A question that proposes a change, drawn on its card (change lines, the
 * "Versions" card the owner approved, 2026-11-18): `Where:` as one plain
 * sentence with a pin right under the question ("See it" opens the `Shows:`
 * picture of the place), then each place's comparison as a quiet two-column
 * list on the card's own ground — `Now`, `After`, `New` — and under a choice
 * that is its own version, that version's words.
 *
 * - Marks: in a Now line the removed words are struck through on a red tint;
 *   in an After line the added words carry a green tint and weight. Never
 *   colour alone (strike, weight), and the screen reader hears the words
 *   removed and added. A mostly rewritten line carries no marks (see
 *   `QUESTION_CHANGE_WHOLE_LINE_SHARE`): Now plain and dimmed, After plain.
 * - Unchanged lines show only beside a change, one on each side, dimmed; a
 *   longer run of them is a quiet "…". A value over twelve lines shows its
 *   first twelve and "Show more".
 * - When the After only adds lines, the Now line goes (the After shows the new
 *   line in its place). `Before: none` reads `New`, unmarked.
 * - The Versions rule: with one place whose Now is text, when every choice but
 *   one carries its own After, that one choice shows today's words in full
 *   and the separate Now line goes; the choices read as the versions.
 * - A choice's own version sits under its row, outside its label (the radio's
 *   name stays the choice's label; the version is its description, through
 *   `aria-describedby`), and in a picture choice's tile under its words.
 * - Pictures: Now and After side by side on a card 480 px wide or more,
 *   stacked under it; a choice's own pair stays side by side. Each opens in
 *   the host's image viewer.
 *
 * No boxes, no left-edge accents, no uppercase labels, no outline rows. A
 * stylesheet (not Tailwind classes) for the reason `QuestionContext` gives.
 */
import React, { useState } from 'react';
import type { ParsedQuestion, QuestionChange, QuestionChangeGroup, QuestionChangeValue, QuestionChoice } from '@plannotator/core/question-block';
import {
  diffQuestionChange,
  questionChangeLines,
  questionChangeMarkedRuns,
  questionChangePlainText,
  type QuestionChangeLine,
  type QuestionChangeMarkedToken,
  type QuestionChangeRow,
  type QuestionChangeToken,
} from '../../utils/questionChangeDiff';

const QUESTION_CHANGE_CSS = `
.qc-where { display: flex; gap: 7px; align-items: flex-start; margin-top: 6px; font-size: 13px; line-height: 1.5; color: var(--muted-foreground); }
.qc-where > svg { flex: none; margin-top: 3px; }
.qc-where-text { min-width: 0; overflow-wrap: anywhere; }
.qc-see { display: inline; margin-inline-start: 6px; padding: 0 2px; border: 0; border-radius: 4px; background: none; font: inherit; font-size: 12.5px; font-weight: 600; line-height: inherit; color: var(--primary); white-space: nowrap; cursor: pointer; }
.qc-see > svg { display: inline-block; vertical-align: -0.125em; margin-inline-end: 4px; }
.qc-see:hover { text-decoration: underline; text-underline-offset: 2px; }
.qc-see:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.qc-src { display: block; font-size: 12px; }
.qc-cmp { margin-top: 10px; }
.qc-cmp + .qc-cmp { margin-top: 14px; }
.qc-gh { margin: 0 0 6px; font-size: 12.5px; font-weight: 600; line-height: 1.45; color: color-mix(in oklab, var(--foreground) 80%, transparent); }
.qc-cmp > .qc-where { margin-top: 0; margin-bottom: 6px; }
.qc-grid { display: grid; grid-template-columns: max-content minmax(0, 1fr); column-gap: 12px; row-gap: 6px; font-size: 13.5px; line-height: 1.5; }
.qc-k { font-size: 12.5px; line-height: 1.6; color: var(--muted-foreground); }
.qc-v { min-width: 0; color: var(--foreground); overflow-wrap: anywhere; }
.qc-now { color: color-mix(in oklab, var(--foreground) 72%, transparent); }
.qc-quiet { color: var(--muted-foreground); }
.qc-line { display: block; margin: 0; }
.qc-line + .qc-line { margin-top: 2px; }
.qc-li { display: flex; gap: 7px; }
.qc-li > .qc-bullet { flex: none; color: var(--muted-foreground); }
.qc-h { font-weight: 600; }
.qc-dim { color: color-mix(in oklab, var(--foreground) 62%, transparent); }
.qc-gap { color: var(--muted-foreground); letter-spacing: 0.1em; }
.qc-link { color: var(--primary); text-decoration: underline; text-decoration-color: color-mix(in oklab, var(--primary) 40%, transparent); text-underline-offset: 2px; }
.qc-dim .qc-link, .qc-now .qc-link { color: inherit; }
.qc-code { font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 0.92em; }
ins.qc-ins { text-decoration: none; color: inherit; font-weight: 600; background: color-mix(in oklab, var(--success) 18%, transparent); border-radius: 3px; padding: 0 2px; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
/* Bold text already carries the weight: an added word there is underlined too, never told by its tint alone. */
.qc-h ins.qc-ins, ins.qc-ins strong { text-decoration: underline; text-decoration-thickness: 1.5px; text-underline-offset: 3px; text-decoration-color: color-mix(in oklab, var(--success) 80%, currentColor); }
del.qc-del { color: inherit; text-decoration: line-through; text-decoration-thickness: 1px; text-decoration-color: color-mix(in oklab, var(--destructive) 75%, currentColor); background: color-mix(in oklab, var(--destructive) 13%, transparent); border-radius: 3px; padding: 0 2px; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
.qc-more { display: inline; margin-top: 4px; padding: 0 2px; border: 0; border-radius: 4px; background: none; font: inherit; font-size: 12.5px; font-weight: 600; color: var(--primary); cursor: pointer; }
.qc-more:hover { text-decoration: underline; text-underline-offset: 2px; }
.qc-more:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
/* A choice's own version, under its row and lined up with its words (a host with a wider control sets the indent). */
.qc-choice { display: block; margin-inline: var(--qc-choice-indent, 34px) 9px; padding-block: 0 6px; font-size: 13.5px; font-weight: 400; color: color-mix(in oklab, var(--foreground) 88%, transparent); }
/* The words pick the choice, as its row does; pictures, captions and the gaps between them do not. */
[data-question-choice-words] { cursor: pointer; }
.qc-readonly [data-question-choice-words] { cursor: default; }
.qc-choice.qc-keep { color: color-mix(in oklab, var(--foreground) 64%, transparent); }
.qc-place { display: block; }
.qc-place + .qc-place { margin-top: 6px; }
.qc-place > .qc-grid { margin-top: 2px; }
.qc-cw { display: block; font-size: 12.5px; line-height: 1.5; color: var(--muted-foreground); }
.qc-pair { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; max-width: 560px; }
@container qcard (min-width: 480px) { .qc-pair { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.qc-pair.qc-pair-sm { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; max-width: 400px; margin-block: 6px 4px; }
.qc-pair.qc-one { grid-template-columns: minmax(0, 1fr); max-width: 520px; }
/* In a picture choice's tile: under its words, the tile's full width. */
.qc-tile { display: block; padding-block: 0 9px; padding-inline: var(--qc-tile-indent, 33px) 10px; font-size: 12.5px; line-height: 1.45; color: color-mix(in oklab, var(--foreground) 88%, transparent); }
.qc-tile .qc-grid { font-size: 12.5px; line-height: 1.45; column-gap: 8px; }
.qc-tile .qc-k { font-size: 12px; }
.qc-tile .qc-pair.qc-pair-sm { max-width: none; margin-block: 2px 0; }
.qc-fig { margin: 0; min-width: 0; }
.qc-pic { display: grid; place-items: center; width: 100%; min-height: 48px; padding: 0; border: 0; border-radius: 8px; overflow: hidden; background: color-mix(in oklab, var(--muted) 45%, transparent); box-shadow: 0 0 0 1px color-mix(in oklab, var(--foreground) 10%, transparent); cursor: zoom-in; }
.qc-pic > img { display: block; width: 100%; height: auto; max-height: 420px; object-fit: contain; }
.qc-pic:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.qc-pic-missing { min-height: 72px; padding: 10px; font-size: 12px; color: var(--muted-foreground); cursor: default; text-align: center; }
.qc-cap { margin-top: 4px; font-size: 12px; line-height: 1.4; color: var(--muted-foreground); overflow-wrap: anywhere; }
.qc-cap > b { font-weight: 600; color: color-mix(in oklab, var(--foreground) 80%, transparent); }
.qc-pair-sm .qc-cap { font-size: 12px; }
.qc-cap-words { display: block; color: color-mix(in oklab, var(--foreground) 80%, transparent); }
.qc-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
`;

/** The stylesheet, hoisted into <head> once (React 19), whatever renders first. */
const Style = () => <style href="plannotator-question-change" precedence="default">{QUESTION_CHANGE_CSS}</style>;

const PinGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Z" strokeLinejoin="round" />
    <circle cx="12" cy="9.5" r="2.5" />
  </svg>
);

const PictureGlyph = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="9" cy="10" r="1.5" />
    <path d="m3 16 5-5 4 4 3-3 6 6" strokeLinejoin="round" />
  </svg>
);

/** What the card gives the change parts: its inline markdown and its pictures. */
export interface QuestionChangeHost {
  /** The card's inline markdown (a Where may link). */
  inline: (text: string) => React.ReactNode;
  /** The URL a picture loads from, or null when the host cannot show it. */
  pictureSrc: (src: string) => string | null;
  /** The host's placeholder for a picture it holds back, or null. */
  heldPlaceholder?: (src: string, alt: string) => React.ReactNode;
  /** Pictures that failed to load, by URL. */
  failed?: ReadonlySet<string>;
  onPictureError?: (url: string) => void;
  /** Opens a picture in the host's viewer. */
  onOpenPicture?: (url: string, alt: string) => void;
}

/** A choice's places: `places` when it has several, else its one Before / After, else none. */
export function questionChoicePlaces(choice: QuestionChoice): QuestionChangeGroup[] {
  if (choice.places) return choice.places;
  if (!choice.before && !choice.after) return [];
  return [{ ...(choice.before ? { before: choice.before } : {}), ...(choice.after ? { after: choice.after } : {}) }];
}

/**
 * The one choice that keeps today's words (the Versions rule), or -1: every
 * place of the question has a text Now and no After of its own, and every
 * choice but one carries its own text After (and no Before of its own).
 */
export function questionKeepChoice(question: Pick<ParsedQuestion, 'change' | 'choices' | 'kind'>): number {
  const groups = question.change?.groups ?? [];
  if (question.kind === 'text' || groups.length === 0 || question.choices.length < 2) return -1;
  if (groups.some((g) => g.before?.kind !== 'text' || g.after)) return -1;
  const places = question.choices.map(questionChoicePlaces);
  if (places.some((list) => list.some((p) => p.before || (p.after && p.after.kind !== 'text')))) return -1;
  const without = places.flatMap((list, i) => (list.some((p) => p.after) ? [] : [i]));
  return without.length === 1 ? without[0] : -1;
}

/** The After the question's place `index` is marked against: its own, else the recommended choice's there, else the first choice's. */
function referenceAfter(question: Pick<ParsedQuestion, 'change' | 'choices'>, index: number): QuestionChangeValue | undefined {
  const group = question.change?.groups[index];
  if (group?.after) return group.after;
  const own = question.choices
    .map((c) => ({ c, after: questionChoicePlaces(c)[index]?.after }))
    .filter((x) => x.after?.kind === 'text');
  return (own.find((x) => x.c.recommended) ?? own[0])?.after;
}

const textOf = (value: QuestionChangeValue | undefined): string | null => (value?.kind === 'text' ? value.text : null);

/** Over this many lines a side shows its first ones and "Show more". */
export const QUESTION_CHANGE_LINE_CAP = 12;

type Side = 'before' | 'after';

/** One token as drawn: emphasis, a link's look (never a live link: the words show a screen), code. */
function tokenNode(token: QuestionChangeToken, key: number): React.ReactNode {
  let node: React.ReactNode = token.text;
  if (token.kind === 'link') node = <span className="qc-link">{node}</span>;
  else if (token.kind === 'code') node = <code className="qc-code">{node}</code>;
  else if (token.kind === 'image') node = <>[{node}]</>;
  if (token.em) node = <em>{node}</em>;
  if (token.bold) node = <strong>{node}</strong>;
  return <React.Fragment key={key}>{node}</React.Fragment>;
}

/** A line's tokens, marked runs wrapped in one `<del>` / `<ins>` each (spaces at their edges left outside). */
function markedNodes(tokens: readonly QuestionChangeMarkedToken[], side: Side): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let run: QuestionChangeMarkedToken[] = [];
  let key = 0;
  const flush = () => {
    if (run.length === 0) return;
    let start = 0;
    let end = run.length;
    while (start < end && run[start].kind === 'space') start++;
    while (end > start && run[end - 1].kind === 'space') end--;
    run.slice(0, start).forEach((t) => out.push(tokenNode(t, key++)));
    if (end > start) {
      const inner = run.slice(start, end).map((t, i) => tokenNode(t, i));
      out.push(side === 'before'
        ? <del key={key++} className="qc-del">{inner}</del>
        : <ins key={key++} className="qc-ins">{inner}</ins>);
    }
    run.slice(end).forEach((t) => out.push(tokenNode(t, key++)));
    run = [];
  };
  for (const t of tokens) {
    if (t.mark) run.push(t);
    else {
      flush();
      out.push(tokenNode(t, key++));
    }
  }
  flush();
  return out;
}

function LineView({ line, children, dim }: { line: QuestionChangeLine; children: React.ReactNode; dim?: boolean }) {
  const cls = ['qc-line', line.kind === 'li' ? 'qc-li' : '', line.kind === 'h' ? 'qc-h' : '', dim ? 'qc-dim' : ''].filter(Boolean).join(' ');
  // Spans drawn as blocks: phrasing content only, wherever a host puts them. `dir="auto"`: each line takes its own direction.
  return line.kind === 'li'
    ? <span className={cls} dir="auto"><span className="qc-bullet">{line.marker}</span><span>{children}</span></span>
    : <span className={cls} dir="auto">{children}</span>;
}

type SideMode = 'all' | 'near' | 'changed';
/** A side's drawn lines: a row by its index, or a gap of unchanged lines not shown. */
type SideItem = { row: number } | { gap: true };

/**
 * The lines one side draws. `all` every line; `near` the changed lines and
 * the nearest unchanged line on each side of them, a longer run of unchanged
 * lines a gap (one lone line is drawn: a "…" would take its room); `changed`
 * the changed lines only (all when none changed).
 */
function sideItems(rows: readonly QuestionChangeRow[], side: Side, mode: SideMode): SideItem[] {
  const own = (r: QuestionChangeRow) => (side === 'before' ? r.type !== 'add' : r.type !== 'del');
  const changed = (r: QuestionChangeRow) => r.type !== 'same';
  const mine = rows.flatMap((r, i) => (own(r) ? [i] : []));
  if (mode === 'all' || !rows.some(changed)) return mine.map((row) => ({ row }));
  const keep = new Set<number>();
  mine.forEach((i, k) => {
    if (!changed(rows[i]!)) return;
    keep.add(i);
    if (mode === 'near') {
      if (k > 0) keep.add(mine[k - 1]!);
      if (k < mine.length - 1) keep.add(mine[k + 1]!);
    }
  });
  if (keep.size === 0) return mine.map((row) => ({ row }));
  const out: SideItem[] = [];
  let hidden: number[] = [];
  // Only the near view says lines were left out; the changed-only view is a choice's short version.
  const flush = () => {
    if (mode === 'near' && hidden.length === 1) out.push({ row: hidden[0]! });
    else if (mode === 'near' && hidden.length > 0) out.push({ gap: true });
    hidden = [];
  };
  for (const i of mine) {
    if (keep.has(i)) {
      flush();
      out.push({ row: i });
    } else hidden.push(i);
  }
  flush();
  return out;
}

/** One side of the rows (see `sideItems`). `marks`: draw the word marks (else plain). `limit`: draw at most this many lines. */
function SideView({ rows, side, mode, marks, limit }: { rows: readonly QuestionChangeRow[]; side: Side; mode: SideMode; marks: boolean; limit?: number }) {
  // Unchanged lines are dimmed only beside a change (a new value, or a whole text with nothing to compare, reads plain).
  const anyChange = rows.some((r) => r.type !== 'same');
  const items = sideItems(rows, side, mode);
  const out: React.ReactNode[] = [];
  items.slice(0, limit ?? items.length).forEach((item, k) => {
    if ('gap' in item) {
      out.push(<span key={`g${k}`} className="qc-line qc-gap">…</span>);
      return;
    }
    const i = item.row;
    const r = rows[i]!;
    if (r.type === 'same') {
      const line = side === 'before' ? r.before : r.after;
      out.push(<LineView key={i} line={line} dim={anyChange && mode !== 'changed' && mode !== 'all'}>{line.tokens.map(tokenNode)}</LineView>);
    } else if (r.type === 'mod') {
      const line = side === 'before' ? r.before : r.after;
      const tokens = side === 'before' ? r.beforeTokens : r.afterTokens;
      out.push(<LineView key={i} line={line}>{marks && !r.whole ? markedNodes(tokens, side) : line.tokens.map(tokenNode)}</LineView>);
    } else {
      const line = r.type === 'del' ? r.before : r.after;
      const whole = line.tokens.map(tokenNode);
      out.push(<LineView key={i} line={line}>{marks && !r.unmarked ? (r.type === 'del' ? <del className="qc-del">{whole}</del> : <ins className="qc-ins">{whole}</ins>) : whole}</LineView>);
    }
  });
  return <>{out}</>;
}

/** How many lines a side draws (for the cap). */
const sideCount = (rows: readonly QuestionChangeRow[], side: Side, mode: SideMode) => sideItems(rows, side, mode).length;

/** "Show more" for sides over the cap: the limit to draw them at, and the button (null when every side fits). */
function useLineCap(counts: readonly number[]): { limit: number | undefined; toggle: React.ReactNode } {
  const [open, setOpen] = useState(false);
  if (Math.max(0, ...counts) <= QUESTION_CHANGE_LINE_CAP) return { limit: undefined, toggle: null };
  return {
    limit: open ? undefined : QUESTION_CHANGE_LINE_CAP,
    toggle: (
      <button
        type="button"
        className="qc-more annotation-exclude"
        aria-expanded={open}
        data-question-change-more=""
        onClick={(event) => {
          // Never the choice's pick: the version under a choice picks it when clicked.
          event.stopPropagation();
          setOpen(!open);
        }}
      >
        {open ? 'Show less' : 'Show more'}
      </button>
    ),
  };
}

/** The screen reader's sentence for a comparison: where, now, after, and the words removed and added. */
function spoken(parts: { where?: string; now?: QuestionChangeValue; after?: QuestionChangeValue; afterLabel?: string; rows?: readonly QuestionChangeRow[] }): string {
  const say = (value: QuestionChangeValue | undefined): string =>
    !value ? '' : value.kind === 'none' ? 'nothing there' : value.kind === 'image' ? `picture: ${value.alt || 'no description'}.${value.caption ? ` ${value.caption}` : ''}` : questionChangePlainText(value.text);
  const out: string[] = [];
  if (parts.where) out.push(`Where: ${parts.where.replace(/[.\s]*$/, '')}.`);
  if (parts.now) out.push(`Now: ${say(parts.now)}`);
  if (parts.after) out.push(`${parts.afterLabel ?? 'After'}: ${parts.after.kind === 'none' ? 'removed.' : say(parts.after)}`);
  if (parts.rows) {
    const { removed, added } = questionChangeMarkedRuns(parts.rows);
    if (removed.length) out.push(`Removed: ${removed.map((w) => `“${w}”`).join(', ')}.`);
    if (added.length) out.push(`Added: ${added.map((w) => `“${w}”`).join(', ')}.`);
  }
  return out.join(' ');
}

/** A picture's alt without the side's own label written at its start ("Now: the row…" → "the row…"). */
const altWithout = (label: string, alt: string | undefined): string =>
  (alt ?? '').replace(new RegExp(`^${label}\\s*[:·—–-]?\\s*`, 'i'), '').trim();

/** One picture: opens in the viewer; a held picture is the host's placeholder; a failed one says so. */
function Picture({ value, label, name, caption, host }: {
  value: Extract<QuestionChangeValue, { kind: 'image' }>;
  /** Its side: Now, After or New. */
  label: string;
  /** What tells this picture apart from the others on the card: its choice's label, else its own alt. */
  name: string;
  caption: React.ReactNode;
  host: QuestionChangeHost;
}) {
  const url = host.pictureSrc(value.src);
  const held = url === null ? host.heldPlaceholder?.(value.src, value.alt) ?? null : null;
  const failed = url !== null && host.failed?.has(url);
  return (
    <figure className="qc-fig" data-question-change-picture="">
      {url !== null && !failed ? (
        <button
          type="button"
          className="qc-pic"
          aria-label={`Open the picture: ${label}${name ? `, ${name}` : ''}`}
          onClick={(event) => {
            event.stopPropagation();
            host.onOpenPicture?.(url, value.alt);
          }}
        >
          <img src={url} alt="" draggable={false} data-question-picture="" data-zoomable="" data-image-src={value.src} onError={() => host.onPictureError?.(url)} />
        </button>
      ) : (
        <div className="qc-pic qc-pic-missing">{held ?? (failed ? 'Picture didn’t load' : value.alt || 'Picture')}</div>
      )}
      <figcaption className="qc-cap">{caption}{value.caption ? <span className="qc-cap-words" dir="auto">{value.caption}</span> : null}</figcaption>
    </figure>
  );
}

const captionOf = (label: string, alt: string | undefined, short: boolean) => {
  const rest = altWithout(label, alt);
  return (
    <>
      <b>{label}</b>
      {!short && rest ? <> · {rest}</> : null}
    </>
  );
};

/** A Now / After pair of which at least one side is a picture. `choiceLabel`: the choice it belongs to (its pictures' names). */
function PicturePair({ before, after, host, small, choiceLabel }: { before?: QuestionChangeValue; after?: QuestionChangeValue; host: QuestionChangeHost; small?: boolean; choiceLabel?: string }) {
  const figures: React.ReactNode[] = [];
  const side = (value: QuestionChangeValue, label: string, key: string) => {
    if (value.kind === 'image') {
      const name = choiceLabel ?? altWithout(label, value.alt);
      figures.push(<Picture key={key} value={value} label={label} name={name} caption={captionOf(label, value.alt, !!small)} host={host} />);
    } else if (value.kind === 'text') {
      figures.push(
        <figure key={key} className="qc-fig">
          <span className="qc-v" style={{ display: 'block' }}>{questionChangeLines(value.text).map((line, i) => <LineView key={i} line={line}>{line.tokens.map(tokenNode)}</LineView>)}</span>
          <figcaption className="qc-cap"><b>{label}</b></figcaption>
        </figure>,
      );
    }
  };
  if (before && before.kind !== 'none') side(before, 'Now', 'b');
  if (after && after.kind !== 'none') side(after, before?.kind === 'none' ? 'New' : 'After', 'a');
  if (after?.kind === 'none') figures.push(<figure key="gone" className="qc-fig"><div className="qc-pic qc-pic-missing">Removed</div><figcaption className="qc-cap"><b>After</b></figcaption></figure>);
  return <div className={['qc-pair', small ? 'qc-pair-sm' : '', figures.length === 1 && !small ? 'qc-one' : ''].filter(Boolean).join(' ')}>{figures}</div>;
}

/** The pin and the place in words, and "See it" when the question shows a picture of the place. */
export function QuestionWhere({ id, where, host, place, source }: {
  id?: string;
  where: string;
  host: QuestionChangeHost;
  /** The `Shows:` picture: its loaded URL and its alt (with the source, for the opened view). */
  place?: { url: string; alt: string } | null;
  /** The question's `Source:` when "See it" cannot carry it (no picture to open): shown as written. */
  source?: string;
}) {
  return (
    <div id={id} className="qc-where" data-question-part="where">
      <Style />
      <PinGlyph />
      <span className="qc-where-text" dir="auto">
        <span className="qc-sr">Where: </span>
        {host.inline(where)}
        {place && host.onOpenPicture && (
          <button type="button" className="qc-see annotation-exclude" data-question-see-it="" onClick={() => host.onOpenPicture!(place.url, place.alt)}>
            <PictureGlyph />
            See it
            <span className="qc-sr">: {place.alt}</span>
          </button>
        )}
        {source && !(place && host.onOpenPicture) ? <span className="qc-src" data-question-change-source="">Source: {source}</span> : null}
      </span>
    </div>
  );
}

/** One place's comparison. */
function GroupView({ question, index, group, heading, ownWhere, keep, host, place, source }: {
  question: Pick<ParsedQuestion, 'change' | 'choices'>;
  index: number;
  group: QuestionChangeGroup;
  heading: boolean;
  ownWhere: boolean;
  keep: boolean;
  host: QuestionChangeHost;
  place?: { url: string; alt: string } | null;
  source?: string;
}) {
  const before = textOf(group.before);
  const refText = textOf(referenceAfter(question, index));
  const pictures = group.before?.kind === 'image' || group.after?.kind === 'image';
  // Memoised on the words: a diff that ran out of time is not cached, so it must not run again on every render.
  const rows = React.useMemo(() => diffQuestionChange(before, refText ?? before), [before, refText]);
  const afterText = group.after?.kind === 'text' ? group.after.text : null;
  const afterRows = React.useMemo(() => (afterText !== null ? diffQuestionChange(before ?? afterText, afterText) : null), [before, afterText]);
  const isNew = group.before?.kind === 'none';
  const pureAdd = before !== null && group.after?.kind === 'text' && rows.every((r) => r.type === 'same' || r.type === 'add');
  const showNow = !pictures && !keep && !pureAdd && group.before !== undefined && group.before.kind !== 'none';
  const afterMode: SideMode = isNew || before === null ? 'all' : 'near';
  const cap = useLineCap([showNow ? sideCount(rows, 'before', 'near') : 0, afterRows ? sideCount(afterRows, 'after', afterMode) : 0]);
  const head = group.where
    ? heading
      ? <p className="qc-gh" dir="auto">{host.inline(group.where)}</p>
      : ownWhere ? <QuestionWhere where={group.where} host={host} place={place} source={source} /> : null
    : null;
  if (!group.before && !group.after) return head ? <div className="qc-cmp" data-question-change-group="">{head}</div> : null;
  if (pictures) {
    return (
      <div className="qc-cmp" data-question-change-group="">
        {head}
        <PicturePair before={group.before} after={group.after} host={host} />
      </div>
    );
  }
  const afterLabel = isNew ? 'New' : 'After';
  if (!showNow && !group.after) return head ? <div className="qc-cmp" data-question-change-group="">{head}</div> : null;
  return (
    <div className="qc-cmp" data-question-change-group="">
      {head}
      <div className="qc-grid" aria-hidden="true">
        {showNow && (
          <>
            <span className="qc-k">Now</span>
            <div className="qc-v qc-now" data-question-change-now="">
              <SideView rows={rows} side="before" mode="near" marks={refText !== null} limit={cap.limit} />
            </div>
          </>
        )}
        {group.after && (
          <>
            <span className="qc-k">{afterLabel}</span>
            <div className={group.after.kind === 'none' ? 'qc-v qc-quiet' : 'qc-v'} data-question-change-after="">
              {group.after.kind === 'none'
                ? 'Removed'
                : <SideView rows={afterRows!} side="after" mode={afterMode} marks={!isNew && before !== null} limit={cap.limit} />}
            </div>
          </>
        )}
      </div>
      {cap.toggle}
      <p className="qc-sr">
        {spoken({
          where: heading ? group.where : undefined,
          now: showNow ? group.before : undefined,
          after: group.after,
          afterLabel,
          rows: refText !== null && before !== null && (showNow || group.after) ? rows : undefined,
        })}
      </p>
    </div>
  );
}

/**
 * Every place's comparison, in order. With the question's own Where drawn
 * above (by `QuestionWhere`), a place's own Where is a small heading; without
 * it, each place leads with its own pin.
 */
export function QuestionChangeGroups({ question, host, place, source }: {
  question: Pick<ParsedQuestion, 'change' | 'choices' | 'kind'>;
  host: QuestionChangeHost;
  /** The place picture's "See it", for the first place's own Where when the question has no Where of its own. */
  place?: { url: string; alt: string } | null;
  /** The `Source:` to show as written when there is no place picture to carry it. */
  source?: string;
}) {
  const change: QuestionChange | undefined = question.change;
  if (!change || change.groups.length === 0) return null;
  const keep = questionKeepChoice(question) !== -1;
  const firstWhere = change.where === undefined ? change.groups.findIndex((g) => g.where !== undefined) : -1;
  return (
    <div data-question-part="change">
      <Style />
      {change.groups.map((group, i) => (
        <GroupView
          key={i}
          question={question}
          index={i}
          group={group}
          heading={change.where !== undefined}
          ownWhere={change.where === undefined}
          keep={keep}
          host={host}
          place={i === firstWhere ? place : null}
          source={i === firstWhere ? source : undefined}
        />
      ))}
    </div>
  );
}

/** One place of a choice in words: its Where (when the question has several places), then its version. */
function ChoicePlace({ where, place, groupBefore }: { where?: string; place: QuestionChangeGroup; groupBefore: string | null }) {
  const own = textOf(place.before);
  const after = place.after;
  const afterText = after?.kind === 'text' ? after.text : null;
  const rows = React.useMemo(
    () => (afterText !== null ? diffQuestionChange(own ?? groupBefore ?? afterText, afterText) : null),
    [own, groupBefore, afterText],
  );
  const mode: SideMode = own !== null ? 'near' : groupBefore !== null ? 'changed' : 'all';
  const cap = useLineCap(rows ? [own !== null ? sideCount(rows, 'before', 'near') : 0, sideCount(rows, 'after', mode)] : []);
  if (!after || after.kind === 'image' || place.before?.kind === 'image') return null;
  const head = where ? <span className="qc-cw" dir="auto">{where}</span> : null;
  // The words are hidden from the screen reader (they reach it as the input's description); "Show more" is not.
  if (after.kind === 'none') {
    return <span className="qc-place"><span aria-hidden="true">{head}<span className="qc-quiet">Removed</span></span></span>;
  }
  if (own !== null) {
    return (
      <span className="qc-place">
        <span aria-hidden="true" style={{ display: 'block' }}>
          {head}
          <span className="qc-grid">
            <span className="qc-k">Now</span>
            <span className="qc-v qc-now"><SideView rows={rows!} side="before" mode="near" marks limit={cap.limit} /></span>
            <span className="qc-k">After</span>
            <span className="qc-v"><SideView rows={rows!} side="after" mode="near" marks limit={cap.limit} /></span>
          </span>
        </span>
        {cap.toggle}
      </span>
    );
  }
  return (
    <span className="qc-place">
      <span aria-hidden="true" style={{ display: 'block' }}>
        {head}
        <span className="qc-v" style={{ display: 'block' }}>
          <SideView rows={rows!} side="after" mode={mode} marks={groupBefore !== null} limit={cap.limit} />
        </span>
      </span>
      {cap.toggle}
    </span>
  );
}

/** One place of today's words on the choice that keeps them (Versions): in full, up to the line cap. */
function KeepPlace({ where, before }: { where?: string; before: string | null }) {
  const rows = React.useMemo(() => diffQuestionChange(before, before), [before]);
  const cap = useLineCap([sideCount(rows, 'before', 'all')]);
  return (
    <span className="qc-place">
      <span aria-hidden="true" style={{ display: 'block' }}>
        {where ? <span className="qc-cw" dir="auto">{where}</span> : null}
        <SideView rows={rows} side="before" mode="all" marks={false} limit={cap.limit} />
      </span>
      {cap.toggle}
    </span>
  );
}

/** What a screen reader hears for one place of a choice. */
function spokenPlace(where: string | undefined, place: QuestionChangeGroup, groupBefore: string | null): string {
  const own = textOf(place.before);
  const base = own ?? groupBefore;
  const rows = place.after?.kind === 'text' && base !== null ? diffQuestionChange(base, place.after.text) : undefined;
  return spoken({ where, now: own !== null ? place.before : undefined, after: place.after, rows });
}

/** A choice's places in words (not pictures), each with the Where it is read under. */
function wordsPlacesOf(question: Pick<ParsedQuestion, 'change'>, choice: QuestionChoice) {
  const groups = question.change?.groups ?? [];
  const places = questionChoicePlaces(choice);
  const several = groups.length > 1 || places.length > 1;
  return places
    .map((place, k) => ({ place, k, where: place.where ?? (several ? groups[k]?.where : undefined), groupBefore: textOf(groups[k]?.before) }))
    .filter(({ place }) => place.after && place.after.kind !== 'image' && place.before?.kind !== 'image');
}

/** A choice's places in pictures (pick any: each choice its own change). */
const picturePlacesOf = (choice: QuestionChoice) =>
  questionChoicePlaces(choice).filter((p) => p.after?.kind === 'image' || p.before?.kind === 'image');

/** Whether a choice has anything of its own to draw: a version, pictures, or (Versions) today's words. */
export function questionChoiceHasChange(question: Pick<ParsedQuestion, 'change' | 'choices' | 'kind'>, choice: QuestionChoice, index: number): boolean {
  if (questionChoicePlaces(choice).length > 0) return wordsPlacesOf(question, choice).length > 0 || picturePlacesOf(choice).length > 0;
  return questionKeepChoice(question) === index;
}

/** What a screen reader hears for a choice's own change (its input's description). */
export function questionChoiceChangeSpoken(question: Pick<ParsedQuestion, 'change' | 'choices' | 'kind'>, choice: QuestionChoice, index: number): string {
  const words = wordsPlacesOf(question, choice);
  const pictures = picturePlacesOf(choice);
  if (words.length > 0 || pictures.length > 0) {
    return [
      ...words.map(({ place, where, groupBefore }) => spokenPlace(where, place, groupBefore)),
      ...pictures.map((place) => spoken({ where: place.where, now: place.before, after: place.after, afterLabel: place.before?.kind === 'none' ? 'New' : 'After' })),
    ].join(' ');
  }
  if (questionChoicePlaces(choice).length === 0 && questionKeepChoice(question) === index) {
    const groups = question.change?.groups ?? [];
    return groups.map((group) => spoken({ where: groups.length > 1 ? group.where : undefined, now: group.before })).join(' ');
  }
  return '';
}

/**
 * A choice's own change, drawn outside its label: its version (or its own
 * Now / After), its pictures, or (Versions) today's words in full. `layout`:
 * `row` under a choice row, lined up with its words; `tile` under a picture
 * choice's words, in its tile. The words are hidden from the screen reader
 * here: they reach it once, as the input's description (`spokenId`).
 */
export function QuestionChoiceChange({ question, choice, index, host, spokenId, layout = 'row', readOnly, onClick }: {
  question: Pick<ParsedQuestion, 'change' | 'choices' | 'kind'>;
  choice: QuestionChoice;
  index: number;
  host: QuestionChangeHost;
  /** The id of the sentence the choice's input is described by. */
  spokenId: string;
  layout?: 'row' | 'tile';
  readOnly?: boolean;
  /** A click on the words (never a picture, a caption, a gap or a button): the host picks the choice, as a click on its row does. */
  onClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const words = wordsPlacesOf(question, choice);
  const pictures = picturePlacesOf(choice);
  const keeps = questionChoicePlaces(choice).length === 0 && questionKeepChoice(question) === index;
  const said = React.useMemo(() => questionChoiceChangeSpoken(question, choice, index), [question, choice, index]);
  if (words.length === 0 && pictures.length === 0 && !keeps) return null;
  const groups = question.change?.groups ?? [];
  const cls = [layout === 'tile' ? 'qc-tile' : 'qc-choice', keeps ? 'qc-keep' : '', readOnly ? 'qc-readonly' : ''].filter(Boolean).join(' ');
  return (
    <div
      className={cls}
      data-question-choice-change=""
      data-question-choice-keeps={keeps ? '' : undefined}
    >
      <Style />
      {words.length > 0 && (
        <div data-question-choice-words="" onClick={onClick}>
          {words.map(({ place, k, where, groupBefore }) => <ChoicePlace key={k} where={where} place={place} groupBefore={groupBefore} />)}
        </div>
      )}
      {pictures.length > 0 && (
        <div data-question-choice-pictures="">
          {pictures.map((place, k) => (
            <React.Fragment key={k}>
              {place.where ? <p className="qc-cw" dir="auto" aria-hidden="true">{place.where}</p> : null}
              <PicturePair before={place.before} after={place.after} host={host} small choiceLabel={choice.label} />
            </React.Fragment>
          ))}
        </div>
      )}
      {keeps && (
        <div data-question-choice-words="" onClick={onClick}>
          {groups.map((group, k) => <KeepPlace key={k} where={groups.length > 1 ? group.where : undefined} before={textOf(group.before)} />)}
        </div>
      )}
      <p id={spokenId} className="qc-sr">{said}</p>
    </div>
  );
}
