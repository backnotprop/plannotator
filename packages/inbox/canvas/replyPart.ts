/**
 * What the thread's canvas puts in its reply box (canvas/useThreadCanvas.tsx, then canvas/useCanvasReply.ts in
 * components/Thread.tsx): the bar's words, the canvas's pictures and scene file, what the agent reads of it, and
 * Send pressed for the person.
 */
import type { CanvasReplySketch } from './canvasApi';

export interface CanvasReplyPart {
  /** The reply's words: they replace the box's (the canvas's bar started from the box's words). */
  words: string;
  files?: File[];
  sketch?: CanvasReplySketch;
  /** Send is pressed for the person once the files are in. */
  send?: boolean;
}

/** A part, for one thread (App holds one at a time; the thread's pane takes it). */
export type CanvasReplyFor = CanvasReplyPart & { threadId: string };

/** A file's name, made "name-2.png", "name-3.png"… when the reply already holds one of that name. */
export function freeName(name: string, taken: readonly string[]): string {
  if (!taken.includes(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let n = 2;
  while (taken.includes(`${stem}-${n}${ext}`)) n++;
  return `${stem}-${n}${ext}`;
}

/** The file under a name the reply doesn't hold yet, so a second send's picture sits beside the first. */
export function withFreeName(file: File, taken: readonly string[]): File {
  const name = freeName(file.name, taken);
  return name === file.name ? file : new File([file], name, { type: file.type });
}
