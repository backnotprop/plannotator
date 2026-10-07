import { useEffect, useState } from 'react';
import type { Shot } from '@plannotator/shared/shots/types';
import { shotImageUrl } from '../api';

export function useShotImage(shot: Shot | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const id = shot?.id;
  const file = shot?.original.file;
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (!id || !file) return;
    shotImageUrl(id, file)
      .then((value) => alive && setUrl(value))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id, file]);
  return url;
}

export function ThumbImage({ shot }: { shot: Shot }) {
  const url = useShotImage(shot);
  return url ? <img src={url} alt="" draggable={false} /> : null;
}

/** Comments on a shot, for the red badge. */
export function commentsOn(shot: Shot): number {
  return shot.boxes.filter((box) => box.comment.trim()).length + (shot.note.trim() ? 1 : 0);
}
