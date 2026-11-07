/**
 * Letter marks for the Inbox's rows (approval "inbox-letter-marks", 2026-11-07). Every control is in Settings → Rows
 * (Look → Mark style; Show → Letter marks, Logo from the repo, GitHub pictures), saved with the other Rows options
 * (config.json `inboxRows`, listLook.ts), and all off by default: with marks off the Inbox looks as it always has.
 *
 * - A thread's mark: the first and last letter of its title by grapheme (`markLetters`), emoji and punctuation
 *   skipped; one glyph for scripts whose letters do not stand alone at this size (Han, kana, Hangul, Arabic,
 *   Devanagari…). Its colour is one of eight hues keyed on the thread id (`hueOf`), so a rename keeps it.
 *   Deterministic: no AI, no randomness.
 * - A project's mark: its picture (the one set with Set picture…, then the repo's logo, then the GitHub owner's, each
 *   served by the Inbox: inbox-project-pictures.ts), else its letters keyed on the project id.
 * - Every mark is decorative (`aria-hidden`): the name is always in text beside it.
 * - Agent icons off (`hideAgents`) also takes the agent mark off the row's hover card (InboxList.tsx `RowMark`).
 */
import { createContext, useContext, useState, type ReactNode } from 'react';
import { lookMarks, useListLook, type ListLook, type MarksChoice, type MarksWhat } from './listLook';
import { projectPictureUrl, useKnownProjects } from './projectPictures';

export type { MarkStyle, MarksChoice, MarksWhat } from './listLook';

export function showsThreads(what: MarksWhat): boolean {
  return what === 'threads' || what === 'both';
}
export function showsProjects(what: MarksWhat): boolean {
  return what === 'projects' || what === 'both';
}

// ── what a row draws ──

/** The parts of the look a row's marks follow. */
export interface RowMarksLook {
  marks: MarksChoice;
  hideAgents: boolean;
  /** False: project marks are letters only, nothing asked of the Inbox (Settings → Rows' sample projects). */
  pictures: boolean;
}

const MARKS_OFF: RowMarksLook = { marks: lookMarks({ marksThreads: false, marksProjects: false, markInline: false, markDot: false, repoLogo: false, githubPictures: false }), hideAgents: false, pictures: false };

/**
 * A look given from above: a list drawn with its own look (Settings → Rows' pictures, the onboarding tour's list and
 * sidebar, which ignore the person's), else the person's own.
 */
const RowMarksContext = createContext<RowMarksLook | null>(null);

export function rowMarksOf(look: ListLook, pictures = true): RowMarksLook {
  return { marks: lookMarks(look), hideAgents: look.hideAgents, pictures };
}

/** Draw `children` with the marks of `look` (null: no marks at all, as the onboarding tour). */
export function RowMarksScope({ look, pictures = true, children }: { look: ListLook | null; pictures?: boolean; children: ReactNode }) {
  return <RowMarksContext.Provider value={look ? rowMarksOf(look, pictures) : MARKS_OFF}>{children}</RowMarksContext.Provider>;
}

/** The marks to draw here: the scope's, else the person's look. */
export function useRowMarks(): RowMarksLook {
  const given = useContext(RowMarksContext);
  const [look] = useListLook(given === null);
  return given ?? rowMarksOf(look);
}

// ── letters ──

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const LETTER = /^[\p{L}\p{N}]/u;
// Two letters only from scripts whose letters stand alone and read as a pair at 10 px. Han, kana and Hangul are
// wide (one fills the tile); Arabic and other joining scripts change shape out of context: one letter for those.
const PAIRS = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Armenian}\p{Script=Georgian}\p{N}]/u;
const PICTO = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

export interface Letters {
  text: string;
  kind: 'letters' | 'emoji' | 'none';
  /** How many glyphs `text` is (1 or 2). */
  count: 1 | 2;
}

/** First and last letter of the name (the owner's rule), letters and digits only: emoji and punctuation are skipped. */
export function markLetters(name: string): Letters {
  const parts = Array.from(graphemes.segment(name.normalize('NFC').trim()), (s) => s.segment);
  const letters = parts.filter((g) => LETTER.test(g));
  if (letters.length === 0) {
    const emoji = parts.find((g) => PICTO.test(g));
    return emoji ? { text: emoji, kind: 'emoji', count: 1 } : { text: '·', kind: 'none', count: 1 };
  }
  const first = letters[0]!;
  const last = letters[letters.length - 1]!;
  if (letters.length === 1 || !PAIRS.test(first) || !PAIRS.test(last)) return { text: first.toLocaleUpperCase(), kind: 'letters', count: 1 };
  return { text: (first + last).toLocaleUpperCase(), kind: 'letters', count: 2 };
}

// ── colour: one of eight hues, turned from the theme's --primary (inbox.css .ib-lm[data-hue]) ──

export const HUES = 8;
/** The hue (0 to 7) for an id: FNV-1a with a final mix, so ids that differ only at the end still spread. */
export function hueOf(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // FNV's low bits follow only the low bits of each character (ids that differ late would share a hue): mix first.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) % HUES;
}

// ── the marks ──

export type MarkSize = 12 | 14 | 16 | 20 | 24 | 30;

/** A thread's or project's letters on a tinted (or solid) tile. Decorative: the name is always in text beside it. */
export function LetterMark({ name, seed, size, solid = false, className, picture }: { name: string; seed: string; size: MarkSize; solid?: boolean; className?: string; picture?: string | null }) {
  const letters = markLetters(name);
  // The picture covers the letters once it has loaded; until then, and when there is none (a 404), the letters show.
  const [loaded, setLoaded] = useState<string | null>(null);
  const shown = !!picture && loaded === picture;
  return (
    <span
      className={`ib-lm${className ? ` ${className}` : ''}`}
      data-hue={hueOf(seed)}
      data-size={size}
      data-solid={solid ? '' : undefined}
      data-kind={letters.kind}
      data-n={letters.count}
      data-pic={shown ? '' : undefined}
      aria-hidden="true"
    >
      {letters.text}
      {picture && <img src={picture} alt="" decoding="async" onLoad={() => setLoaded(picture)} onError={() => setLoaded(null)} />}
    </span>
  );
}

/** A project's mark: its picture when it has one, else its letters (hued by the project id). */
export function ProjectMark({ projectId, name, size, solid = false, className }: { projectId: string; name: string; size: MarkSize; solid?: boolean; className?: string }) {
  const { marks, pictures } = useRowMarks();
  useKnownProjects();
  return <LetterMark name={name} seed={projectId} size={size} solid={solid} className={className} picture={pictures ? projectPictureUrl(projectId, marks) : null} />;
}

/** The colour alone (style "Dot"): an 8 px dot in the thread's hue. */
export function HueDot({ seed }: { seed: string }) {
  return <span className="ib-lm-dot" data-hue={hueOf(seed)} aria-hidden="true" />;
}
