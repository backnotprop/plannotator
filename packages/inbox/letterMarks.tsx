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

export interface RowMarksLook {
  marks: MarksChoice;
  hideAgents: boolean;
  pictures: boolean;
}

const MARKS_OFF: RowMarksLook = { marks: lookMarks({ marksThreads: false, marksProjects: false, markInline: false, markDot: false, repoLogo: false, githubPictures: false }), hideAgents: false, pictures: false };

const RowMarksContext = createContext<RowMarksLook | null>(null);

export function rowMarksOf(look: ListLook, pictures = true): RowMarksLook {
  return { marks: lookMarks(look), hideAgents: look.hideAgents, pictures };
}

export function RowMarksScope({ look, pictures = true, children }: { look: ListLook | null; pictures?: boolean; children: ReactNode }) {
  return <RowMarksContext.Provider value={look ? rowMarksOf(look, pictures) : MARKS_OFF}>{children}</RowMarksContext.Provider>;
}

export function useRowMarks(): RowMarksLook {
  const given = useContext(RowMarksContext);
  const [look] = useListLook(given === null);
  return given ?? rowMarksOf(look);
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const LETTER = /^[\p{L}\p{N}]/u;
const PAIRS = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Armenian}\p{Script=Georgian}\p{N}]/u;
const PICTO = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

export interface Letters {
  text: string;
  kind: 'letters' | 'emoji' | 'none';
  count: 1 | 2;
}

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

export const HUES = 8;
export function hueOf(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) % HUES;
}

export type MarkSize = 12 | 14 | 16 | 20 | 24 | 30;

export function LetterMark({ name, seed, size, solid = false, className, picture }: { name: string; seed: string; size: MarkSize; solid?: boolean; className?: string; picture?: string | null }) {
  const letters = markLetters(name);
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

export function ProjectMark({ projectId, name, size, solid = false, className }: { projectId: string; name: string; size: MarkSize; solid?: boolean; className?: string }) {
  const { marks, pictures } = useRowMarks();
  useKnownProjects();
  return <LetterMark name={name} seed={projectId} size={size} solid={solid} className={className} picture={pictures ? projectPictureUrl(projectId, marks) : null} />;
}

export function HueDot({ seed }: { seed: string }) {
  return <span className="ib-lm-dot" data-hue={hueOf(seed)} aria-hidden="true" />;
}
