/**
 * The reply box's side of the thread's canvas (components/Thread.tsx): a part from the canvas (canvas/replyPart.ts)
 * opens the box with the canvas's words, its pictures and scene file join the box, what the agent reads of the canvas
 * rides the Send that carries them, and the canvas's own Send goes as if the person pressed Send once its files are
 * in. A reply that cannot go by itself (a file refused, a choice to make at Send) stays in the box, and the canvas
 * gives way to it (`onOutcome('held')`).
 */
import { useEffect, useRef, useState } from 'react';
import type { CanvasReplySketch } from './canvasApi';
import { withFreeName, type CanvasReplyPart } from './replyPart';

interface ReplyBoxFiles {
  files: readonly { key: string; state: 'uploading' | 'done' | 'refused' }[];
  current(): readonly { key: string }[];
  add(files: File[]): string[];
}

/**
 * `part`: the canvas's part for this thread, or null; `onTaken` once the box has it. `place` opens the box (if it is
 * closed) with the part's words in place of its own, and answers the names of the files the reply already holds.
 */
export function useCanvasReply(box: ReplyBoxFiles, sending: boolean, send: () => Promise<void>, onOutcome: ((outcome: 'sent' | 'held') => void) | undefined, part: CanvasReplyPart | null, onTaken: (() => void) | undefined, place: (words: string) => string[]) {
  const sketch = useRef<{ sketch: CanvasReplySketch; keys: string[] } | null>(null);
  const want = useRef<{ keys: string[] } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const asked = want.current;
    if (!asked || sending) return;
    const mine = box.files.filter((f) => asked.keys.includes(f.key));
    if (mine.length < asked.keys.length || mine.some((f) => f.state === 'uploading')) return;
    want.current = null;
    if (mine.some((f) => f.state === 'refused')) {
      onOutcome?.('held');
      return;
    }
    void send().then(() => onOutcome?.(box.current().some((f) => asked.keys.includes(f.key)) ? 'held' : 'sent'));
    // send reads this render's box.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [box.files, sending, tick]);
  /** A part from the canvas: its files join the box under free names (`taken`, the names already there), and Send is pressed for the person. */
  const take = (given: CanvasReplyPart, taken: string[]) => {
    const renamed = new Map<string, string>();
    const files = (given.files ?? []).map((file) => {
      const free = withFreeName(file, taken);
      taken.push(free.name);
      renamed.set(file.name, free.name);
      return free;
    });
    const keys = files.length > 0 ? box.add(files) : [];
    if (given.sketch) {
      const pictures = Object.fromEntries(Object.entries(given.sketch.pictures).map(([thing, name]) => [thing, renamed.get(name) ?? name]));
      sketch.current = { sketch: { ...given.sketch, pictures }, keys };
    }
    if (given.send) {
      want.current = { keys };
      setTick((n) => n + 1);
    }
  };
  // A part arrives (or Send ends while one waits): the box takes it.
  useEffect(() => {
    if (!part || sending) return;
    onTaken?.();
    take(part, place(part.words));
    // place reads this render's box and draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [part, sending]);
  return {
    /** The reply's `sketch`, while one of the canvas's files is still in the box (their keys are never reused). */
    sketch: (): { sketch?: CanvasReplySketch } => {
      const held = sketch.current;
      return held && box.current().some((f) => held.keys.includes(f.key)) ? { sketch: held.sketch } : {};
    },
  };
}
