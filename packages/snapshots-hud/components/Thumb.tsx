import { useEffect, useState } from 'react';
import type { Snapshot } from '@plannotator/shared/snapshots/types';
import { snapshotImageUrl } from '../api';

export function useSnapshotImage(snapshot: Snapshot | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const id = snapshot?.id;
  const file = snapshot?.original.file;
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (!id || !file) return;
    snapshotImageUrl(id, file)
      .then((value) => alive && setUrl(value))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id, file]);
  return url;
}

export function ThumbImage({ snapshot }: { snapshot: Snapshot }) {
  const url = useSnapshotImage(snapshot);
  return url ? <img src={url} alt="" draggable={false} /> : null;
}

/** Comments on a snapshot, for the red badge. */
export function commentsOn(snapshot: Snapshot): number {
  return snapshot.boxes.filter((box) => box.comment.trim()).length + (snapshot.note.trim() ? 1 : 0);
}
