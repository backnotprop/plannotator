/**
 * Show me in the Inbox's code review (Show me makes a Shape: approval
 * "code-review-launch-build", item 1): the pure parts. Which chapter a board's
 * part opens, the part's name for the corner card, and which parts of a redrawn
 * Overview changed.
 */
import { shapeHtmlMarks, type ShapeCodeTarget } from '@plannotator/core/shape';
import { guideDiagramIsDrawn } from '@plannotator/core/guide-format';
import type { GuideOverviewDiagram } from '@plannotator/core/guide';

/** A path's last part: "retry-worker.ts". */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * The Overview's diagram as the review pane draws it, a Shape picture: only a
 * drawn one (snapshot version 3, checked by the Inbox when it came). Null for
 * anything else, a version-2 html diagram included, which keeps the guide
 * viewer's own rendering (its note), exactly as before Show me.
 */
export function overviewPicture(diagram: GuideOverviewDiagram | undefined): GuideOverviewDiagram | null {
  return diagram?.kind === 'html' && guideDiagramIsDrawn(diagram) ? diagram : null;
}

type Place = { file: string | null; lines: readonly [number, number] | null };

/**
 * Whether a Show me asked on `asked` (this round's, or an earlier round's) is
 * the one the person means by `place`, so it opens again rather than asking
 * anew: the whole review both;
 * or the same file with the selection inside the asked lines, or sharing at
 * least half of the lines the two cover together. Lines 1–200 are not a
 * picture of 16–18; 15–18 is.
 */
export function showMeSamePlace(asked: Place, place: Place): boolean {
  if (place.file === null || place.lines === null) return asked.file === null && asked.lines === null;
  if (asked.file !== place.file || !asked.lines) return false;
  const [a0, a1] = asked.lines;
  const [p0, p1] = place.lines;
  if (p0 >= a0 && p1 <= a1) return true;
  const shared = Math.min(a1, p1) - Math.max(a0, p0) + 1;
  const together = Math.max(a1, p1) - Math.min(a0, p0) + 1;
  return shared > 0 && shared * 2 >= together;
}

/** A Show me turn as the window reads it (packages/inbox/api.ts `InboxAskTurnWire`). */
interface ShowMeTurn {
  id: string;
  kind?: 'show_me';
  show_me?: { review: string; file: string | null; lines: [number, number] | null };
  shape?: string;
  answer?: string;
  stopped?: boolean;
  failure?: string;
}

/**
 * This review's Show me for `place` that the agent is drawing now: no board
 * and no answer yet, and actually running (the Inbox's running turn, or this
 * window's live stream). A turn the Inbox kept but nobody answers (no
 * connection when asked, or the session gone before a word) is not waiting:
 * Show me on its lines asks anew.
 */
export function waitingShowMe<T extends ShowMeTurn>(turns: readonly T[], reviewId: string, place: Place, running: string | null, live: string | null): T | undefined {
  return turns
    .filter((turn) => turn.kind === 'show_me' && turn.show_me?.review === reviewId && showMeSamePlace(turn.show_me, place))
    .filter((turn) => !turn.shape && turn.answer === undefined && !turn.stopped && turn.failure === undefined)
    .filter((turn) => turn.id === running || turn.id === live)
    .at(-1);
}

/**
 * Where a part's code is: the walkthrough's chapter that holds the file, or
 * null when no chapter does (it opens in All files).
 */
export function chapterOf(chapters: readonly { diffs: readonly { file: string }[] }[], path: string): number | null {
  const at = chapters.findIndex((chapter) => chapter.diffs.some((ref) => ref.file === path));
  return at < 0 ? null : at;
}

/** The lines a part opens, as a pair. */
export function targetLines(target: ShapeCodeTarget): [number, number] {
  return [target.line, target.lineEnd ?? target.line];
}

/**
 * A part's name for the corner card: its first heading or bold words, else
 * its first words. Read from the drawing as the reviewer sees it.
 */
export function partName(el: Element): string {
  const named = el.querySelector('h1, h2, h3, h4, h5, h6, b, strong, .tt, .title, text');
  const words = (named?.textContent ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(words);
  return chars.length > 48 ? `${chars.slice(0, 47).join('').trimEnd()}…` : words;
}

/** The `data-mark` of the part a click landed in, if it has one. */
export function markOf(el: Element): string | null {
  return el.closest('[data-mark]')?.getAttribute('data-mark') ?? null;
}

/**
 * The parts of a redrawn picture that changed: a `data-mark` whose words
 * differ from the earlier drawing's, or that is new. Parts that kept their
 * id and words are not changed.
 */
export function changedMarks(before: readonly string[], after: readonly string[]): Set<string> {
  const was = new Map<string, string>();
  for (const html of before) for (const mark of shapeHtmlMarks(html)) if (!was.has(mark.id)) was.set(mark.id, mark.text);
  const out = new Set<string>();
  const seen = new Set<string>();
  for (const html of after) {
    for (const mark of shapeHtmlMarks(html)) {
      if (seen.has(mark.id)) continue;
      seen.add(mark.id);
      if (was.get(mark.id) !== mark.text) out.add(mark.id);
    }
  }
  return out;
}

/**
 * A Show me that ended with no board and no answer: nothing is running or
 * waiting on a choice, and the person did not stop it. The box goes back to its words.
 */
export function showMeEnded(turn: { answer?: string; stopped?: boolean; shape?: string } | undefined, now: { running: boolean; busy: boolean }): boolean {
  return !now.running && !now.busy && !turn?.shape && !turn?.stopped && turn?.answer === undefined;
}
