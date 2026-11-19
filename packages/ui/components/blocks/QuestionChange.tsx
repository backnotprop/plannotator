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
 * - Unchanged neighbour lines are dimmed; a long value shows its changed
 *   lines with one neighbour each.
 * - When the After only adds lines, the Now line goes (the After shows the new
 *   line in its place). `Before: none` reads `New`, unmarked.
 * - The Versions rule: with one place whose Now is text, when every choice but
 *   one carries its own After, that one choice shows today's words and the
 *   separate Now line goes; the choices read as the versions.
 * - Pictures: Now and After side by side on a card 480 px wide or more,
 *   stacked under it; a choice's own pair stays side by side. Each opens in
 *   the host's image viewer.
 *
 * No boxes, no left-edge accents, no uppercase labels, no outline rows. A
 * stylesheet (not Tailwind classes) for the reason `QuestionContext` gives.
 */
import React from 'react';
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
.qc-see { display: inline-flex; align-items: center; gap: 4px; margin-left: 6px; padding: 0 2px; border: 0; border-radius: 4px; background: none; font: inherit; font-size: 12.5px; font-weight: 600; color: var(--primary); white-space: nowrap; vertical-align: baseline; cursor: pointer; }
.qc-see:hover { text-decoration: underline; text-underline-offset: 2px; }
.qc-see:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
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
.qc-link { color: var(--primary); text-decoration: underline; text-decoration-color: color-mix(in oklab, var(--primary) 40%, transparent); text-underline-offset: 2px; }
.qc-dim .qc-link, .qc-now .qc-link { color: inherit; }
.qc-code { font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 0.92em; }
ins.qc-ins { text-decoration: none; color: inherit; font-weight: 600; background: color-mix(in oklab, var(--success) 18%, transparent); border-radius: 3px; padding: 0 2px; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
del.qc-del { color: inherit; text-decoration: line-through; text-decoration-thickness: 1px; text-decoration-color: color-mix(in oklab, var(--destructive) 75%, currentColor); background: color-mix(in oklab, var(--destructive) 13%, transparent); border-radius: 3px; padding: 0 2px; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
.qc-choice { display: block; margin-top: 2px; font-size: 13.5px; font-weight: 400; color: color-mix(in oklab, var(--foreground) 88%, transparent); }
.qc-choice.qc-keep { color: color-mix(in oklab, var(--foreground) 64%, transparent); }
/* A choice row with its version under the label keeps its control by the label (a host may centre tall rows). */
.question-block label[data-question-option]:has(> [data-question-part="choice"] > [data-question-choice-change]) { align-items: flex-start; }
.qc-place { display: block; }
.qc-place + .qc-place { margin-top: 6px; }
.qc-place > .qc-grid { margin-top: 2px; }
.qc-cw { display: block; font-size: 12.5px; line-height: 1.5; color: var(--muted-foreground); }
.qc-cw-pics { margin: 6px 0 0 34px; }
.qc-pair { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; max-width: 560px; }
@container qcard (min-width: 480px) { .qc-pair { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.qc-pair.qc-pair-sm { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; max-width: 400px; margin: 6px 0 4px 34px; }
.qc-pair.qc-one { grid-template-columns: minmax(0, 280px); }
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

/** A long value (over four lines) shows its changed lines with one neighbour each; a short one shows every line. */
const LONG_VALUE_LINES = 4;

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
  // Spans drawn as blocks: a line may sit inside a choice's label, where only phrasing content belongs.
  return line.kind === 'li'
    ? <span className={cls}><span className="qc-bullet">{line.marker}</span><span>{children}</span></span>
    : <span className={cls}>{children}</span>;
}

/**
 * One side of the rows. `mode`: `all` every line (unchanged ones dimmed),
 * `near` changed lines and one neighbour each (dimmed), `changed` changed
 * lines only. `marks`: draw the word marks (else plain).
 */
function SideView({ rows, side, mode, marks }: { rows: readonly QuestionChangeRow[]; side: Side; mode: 'all' | 'near' | 'changed'; marks: boolean }) {
  const own = (r: QuestionChangeRow) => (side === 'before' ? r.type !== 'add' : r.type !== 'del');
  const changed = (r: QuestionChangeRow) => r.type !== 'same';
  const keep = new Set<number>();
  rows.forEach((r, i) => {
    if (mode === 'all' || (changed(r) && own(r))) keep.add(i);
    if (mode === 'near' && changed(r)) {
      keep.add(i - 1);
      keep.add(i + 1);
    }
  });
  // Nothing changed on this side: show it whole.
  if (mode === 'changed' && keep.size === 0) rows.forEach((_r, i) => keep.add(i));
  // Unchanged lines are dimmed only beside a change (a new value, or a whole text with nothing to compare, reads plain).
  const anyChange = rows.some(changed);
  const out: React.ReactNode[] = [];
  rows.forEach((r, i) => {
    if (!keep.has(i) || !own(r)) return;
    if (r.type === 'same') {
      const line = side === 'before' ? r.before : r.after;
      out.push(<LineView key={i} line={line} dim={anyChange && mode !== 'changed'}>{line.tokens.map(tokenNode)}</LineView>);
    } else if (r.type === 'mod') {
      const line = side === 'before' ? r.before : r.after;
      const tokens = side === 'before' ? r.beforeTokens : r.afterTokens;
      out.push(<LineView key={i} line={line}>{marks && !r.whole ? markedNodes(tokens, side) : line.tokens.map(tokenNode)}</LineView>);
    } else {
      const line = r.type === 'del' ? r.before : r.after;
      const whole = line.tokens.map(tokenNode);
      out.push(<LineView key={i} line={line}>{marks ? (r.type === 'del' ? <del className="qc-del">{whole}</del> : <ins className="qc-ins">{whole}</ins>) : whole}</LineView>);
    }
  });
  return <>{out}</>;
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

/** One picture: opens in the viewer; a held picture is the host's placeholder; a failed one says so. */
function Picture({ value, caption, host }: { value: Extract<QuestionChangeValue, { kind: 'image' }>; caption: React.ReactNode; host: QuestionChangeHost }) {
  const url = host.pictureSrc(value.src);
  const held = url === null ? host.heldPlaceholder?.(value.src, value.alt) ?? null : null;
  const failed = url !== null && host.failed?.has(url);
  return (
    <figure className="qc-fig" data-question-change-picture="">
      {url !== null && !failed ? (
        <button
          type="button"
          className="qc-pic"
          aria-label={`Open the picture: ${value.alt || 'picture'}`}
          onClick={host.onOpenPicture ? () => host.onOpenPicture!(url, value.alt) : undefined}
        >
          <img src={url} alt="" draggable={false} data-question-picture="" data-zoomable="" data-image-src={value.src} onError={() => host.onPictureError?.(url)} />
        </button>
      ) : (
        <div className="qc-pic qc-pic-missing">{held ?? (failed ? 'Picture didn’t load' : value.alt || 'Picture')}</div>
      )}
      <figcaption className="qc-cap">{caption}{value.caption ? <span className="qc-cap-words">{value.caption}</span> : null}</figcaption>
    </figure>
  );
}

const captionOf = (label: string, alt: string | undefined, short: boolean) => (
  <>
    <b>{label}</b>
    {!short && alt && alt.toLowerCase() !== label.toLowerCase() ? <> · {alt.replace(new RegExp(`^${label}:?\\s*`, 'i'), '')}</> : null}
  </>
);

/** A Now / After pair of which at least one side is a picture. */
function PicturePair({ before, after, host, small }: { before?: QuestionChangeValue; after?: QuestionChangeValue; host: QuestionChangeHost; small?: boolean }) {
  const figures: React.ReactNode[] = [];
  const side = (value: QuestionChangeValue, label: string, key: string) => {
    if (value.kind === 'image') figures.push(<Picture key={key} value={value} caption={captionOf(label, value.alt, !!small)} host={host} />);
    else if (value.kind === 'text') {
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
export function QuestionWhere({ id, where, host, place }: {
  id?: string;
  where: string;
  host: QuestionChangeHost;
  /** The `Shows:` picture: its loaded URL and its alt (with the source, for the opened view). */
  place?: { url: string; alt: string } | null;
}) {
  return (
    <div id={id} className="qc-where" data-question-part="where">
      <Style />
      <PinGlyph />
      <span className="qc-where-text">
        <span className="qc-sr">Where: </span>
        {host.inline(where)}
        {place && host.onOpenPicture && (
          <button type="button" className="qc-see annotation-exclude" data-question-see-it="" onClick={() => host.onOpenPicture!(place.url, place.alt)}>
            <PictureGlyph />
            See it
            <span className="qc-sr">: {place.alt}</span>
          </button>
        )}
      </span>
    </div>
  );
}

/** One place's comparison. */
function GroupView({ question, index, group, heading, ownWhere, keep, host, place }: {
  question: Pick<ParsedQuestion, 'change' | 'choices'>;
  index: number;
  group: QuestionChangeGroup;
  heading: boolean;
  ownWhere: boolean;
  keep: boolean;
  host: QuestionChangeHost;
  place?: { url: string; alt: string } | null;
}) {
  const head = group.where
    ? heading
      ? <p className="qc-gh">{host.inline(group.where)}</p>
      : ownWhere ? <QuestionWhere where={group.where} host={host} place={place} /> : null
    : null;
  if (!group.before && !group.after) return head ? <div className="qc-cmp" data-question-change-group="">{head}</div> : null;
  if (group.before?.kind === 'image' || group.after?.kind === 'image') {
    return (
      <div className="qc-cmp" data-question-change-group="">
        {head}
        <PicturePair before={group.before} after={group.after} host={host} />
      </div>
    );
  }
  const before = textOf(group.before);
  const ref = referenceAfter(question, index);
  const refText = textOf(ref);
  const rows = diffQuestionChange(before, refText ?? before);
  const long = questionChangeLines(before ?? textOf(group.after)).length > LONG_VALUE_LINES;
  const mode = long ? 'near' : 'all';
  const pureAdd = before !== null && group.after?.kind === 'text' && rows.every((r) => r.type === 'same' || r.type === 'add');
  const showNow = !keep && !pureAdd && group.before !== undefined && group.before.kind !== 'none';
  const afterRows = group.after?.kind === 'text' ? diffQuestionChange(before ?? group.after.text, group.after.text) : null;
  const isNew = group.before?.kind === 'none';
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
              <SideView rows={rows} side="before" mode={mode} marks={refText !== null} />
            </div>
          </>
        )}
        {group.after && (
          <>
            <span className="qc-k">{afterLabel}</span>
            <div className={group.after.kind === 'none' ? 'qc-v qc-quiet' : 'qc-v'} data-question-change-after="">
              {group.after.kind === 'none'
                ? 'Removed'
                : <SideView rows={afterRows!} side="after" mode={isNew || before === null ? 'all' : mode} marks={!isNew && before !== null} />}
            </div>
          </>
        )}
      </div>
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
export function QuestionChangeGroups({ question, host, place }: {
  question: Pick<ParsedQuestion, 'change' | 'choices' | 'kind'>;
  host: QuestionChangeHost;
  /** The place picture's "See it", for the first place's own Where when the question has no Where of its own. */
  place?: { url: string; alt: string } | null;
}) {
  const change: QuestionChange | undefined = question.change;
  if (!change || change.groups.length === 0) return null;
  const keep = questionKeepChoice(question) !== -1;
  const firstWhere = change.where === undefined ? change.groups.findIndex((g) => g.where !== undefined) : -1;
  return (
    <div data-question-part="change">
      <Style />
      {change.groups.map((group, i) => (
        <GroupView key={i} question={question} index={i} group={group} heading={change.where !== undefined} ownWhere={change.where === undefined} keep={keep} host={host} place={i === firstWhere ? place : null} />
      ))}
    </div>
  );
}

/** One place of a choice in words: its Where (when the question has several places), then its version. */
function ChoicePlace({ where, place, groupBefore }: { where?: string; place: QuestionChangeGroup; groupBefore: string | null }) {
  const own = textOf(place.before);
  const after = place.after;
  if (!after || after.kind === 'image' || place.before?.kind === 'image') return null;
  const head = where ? <span className="qc-cw">{where}</span> : null;
  if (after.kind === 'none') {
    return <span className="qc-place">{head}<span className="qc-quiet">Removed</span></span>;
  }
  if (own !== null) {
    const rows = diffQuestionChange(own, after.text);
    return (
      <span className="qc-place">
        {head}
        <span className="qc-grid">
          <span className="qc-k">Now</span>
          <span className="qc-v qc-now"><SideView rows={rows} side="before" mode="all" marks /></span>
          <span className="qc-k">After</span>
          <span className="qc-v"><SideView rows={rows} side="after" mode="all" marks /></span>
        </span>
      </span>
    );
  }
  const rows = diffQuestionChange(groupBefore ?? after.text, after.text);
  return (
    <span className="qc-place">
      {head}
      <span className="qc-v" style={{ display: 'block' }}>
        <SideView rows={rows} side="after" mode={groupBefore !== null ? 'changed' : 'all'} marks={groupBefore !== null} />
      </span>
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

/** A choice's own words under its label, when it has any: its version, its own change, or (Versions) today's words. Null otherwise. */
export function questionChoiceChangeText(
  question: Pick<ParsedQuestion, 'change' | 'choices' | 'kind'>,
  choice: QuestionChoice,
  index: number,
): React.ReactNode {
  const groups = question.change?.groups ?? [];
  const places = questionChoicePlaces(choice);
  const several = groups.length > 1 || places.length > 1;
  const wordsPlaces = places
    .map((place, k) => ({ place, k, where: place.where ?? (several ? groups[k]?.where : undefined), groupBefore: textOf(groups[k]?.before) }))
    .filter(({ place }) => place.after && place.after.kind !== 'image' && place.before?.kind !== 'image');
  if (wordsPlaces.length > 0) {
    return (
      <span className="qc-choice" data-question-choice-change="">
        <Style />
        <span aria-hidden="true" style={{ display: 'block' }}>
          {wordsPlaces.map(({ place, k, where, groupBefore }) => <ChoicePlace key={k} where={where} place={place} groupBefore={groupBefore} />)}
        </span>
        <span className="qc-sr">{wordsPlaces.map(({ place, where, groupBefore }) => spokenPlace(where, place, groupBefore)).join(' ')}</span>
      </span>
    );
  }
  if (places.length === 0 && questionKeepChoice(question) === index) {
    return (
      <span className="qc-choice qc-keep" data-question-choice-change="" data-question-choice-keeps="">
        <Style />
        <span aria-hidden="true" style={{ display: 'block' }}>
          {groups.map((group, k) => {
            const before = textOf(group.before)!;
            const rows = diffQuestionChange(before, textOf(referenceAfter(question, k)) ?? before);
            return (
              <span key={k} className="qc-place">
                {groups.length > 1 && group.where ? <span className="qc-cw">{group.where}</span> : null}
                <SideView rows={rows} side="before" mode="changed" marks={false} />
              </span>
            );
          })}
        </span>
        <span className="qc-sr">{groups.map((group) => spoken({ where: groups.length > 1 ? group.where : undefined, now: group.before })).join(' ')}</span>
      </span>
    );
  }
  return null;
}

/** A choice's own pictures (pick any: each choice its own change), drawn under its row, outside the label. */
export function QuestionChoicePictures({ choice, host }: { choice: QuestionChoice; host: QuestionChangeHost }) {
  const places = questionChoicePlaces(choice).filter((p) => p.after?.kind === 'image' || p.before?.kind === 'image');
  if (places.length === 0) return null;
  return (
    <div data-question-choice-pictures="">
      <Style />
      {places.map((place, k) => (
        <React.Fragment key={k}>
          {place.where ? <p className="qc-cw qc-cw-pics">{place.where}</p> : null}
          <PicturePair before={place.before} after={place.after} host={host} small />
        </React.Fragment>
      ))}
    </div>
  );
}

/** Whether a choice has pictures of its own to draw under its row. */
export const questionChoiceHasPictures = (choice: QuestionChoice): boolean =>
  questionChoicePlaces(choice).some((p) => p.after?.kind === 'image' || p.before?.kind === 'image');
