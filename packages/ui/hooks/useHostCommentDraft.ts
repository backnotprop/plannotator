import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ImageAttachment } from '../types';
import { CommentDraftHostContext, type HostCommentDraft } from '../components/CommentDraftHost';

const SAVE_AFTER_MS = 400;

const serial = (text: string, images: readonly ImageAttachment[]) => JSON.stringify([text, images]);
const blank = (draft: HostCommentDraft) => draft.text.trim() === '' && draft.images.length === 0;

export interface HostCommentDraftState {
  conflict: HostCommentDraft | null | undefined;
  keepMine: () => void;
  takeTheirs: () => void;
  clear: () => void;
}

export function useHostCommentDraft(
  key: string | undefined,
  text: string,
  images: ImageAttachment[],
  apply: (draft: HostCommentDraft) => void,
): HostCommentDraftState {
  const host = useContext(CommentDraftHostContext);
  const on = host !== null && key !== undefined;
  const [loaded, setLoaded] = useState(false);
  const [conflict, setConflict] = useState<HostCommentDraft | null | undefined>(undefined);
  const saved = useRef('');
  const current = useRef({ text, images });
  current.current = { text, images };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cleared = useRef(false);
  const applyRef = useRef(apply);
  applyRef.current = apply;

  useEffect(() => {
    if (!on) return;
    let live = true;
    const opened = serial(current.current.text, current.current.images);
    setLoaded(false);
    setConflict(undefined);
    cleared.current = false;
    host.read(key).then(
      (draft) => {
        if (!live) return;
        const mine = current.current;
        const theirs = draft ?? { text: '', images: [] };
        const same = serial(theirs.text, theirs.images) === serial(mine.text, mine.images);
        if (!same && !blank(theirs)) {
          if (blank(mine) && serial(mine.text, mine.images) === opened) applyRef.current(theirs);
          else setConflict(theirs);
        }
        saved.current = serial(theirs.text, theirs.images);
        setLoaded(true);
      },
      () => {
        if (live) setLoaded(true);
      },
    );
    return () => {
      live = false;
    };
  }, [on, host, key]);

  const write = useCallback(
    (force = false) => {
      if (!on || cleared.current) return;
      const { text: words, images: files } = current.current;
      const next = serial(words, files);
      const draft = blank({ text: words, images: files }) ? null : { text: words, images: files };
      void host.write(key, draft, { force }).then(
        (result) => {
          if (result === 'saved') {
            saved.current = next;
            setConflict(undefined);
          } else setConflict(result.conflict);
        },
        () => {},
      );
    },
    [on, host, key],
  );

  useEffect(() => {
    if (!on || !loaded || conflict !== undefined || cleared.current) return;
    if (serial(text, images) === saved.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      write();
    }, SAVE_AFTER_MS);
  }, [on, loaded, conflict, text, images, write]);

  useEffect(
    () => () => {
      if (!timer.current) return;
      clearTimeout(timer.current);
      timer.current = null;
      write();
    },
    [write],
  );

  const keepMine = useCallback(() => write(true), [write]);
  const takeTheirs = useCallback(() => {
    const theirs = conflict ?? { text: '', images: [] };
    applyRef.current(theirs);
    saved.current = serial(theirs.text, theirs.images);
    setConflict(undefined);
  }, [conflict]);
  const clear = useCallback(() => {
    if (!on) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    cleared.current = true;
    void host.write(key, null, { force: true }).catch(() => {});
  }, [on, host, key]);

  return { conflict, keepMine, takeTheirs, clear };
}
