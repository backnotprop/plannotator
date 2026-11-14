import { useEffect, useState } from 'react';

export interface ImageSideSize {
  bytes: number;
  width?: number;
  height?: number;
}

export type ImageSizes = Record<string, Partial<Record<'old' | 'new', ImageSideSize>>>;

export const IMAGE_SIZES_WAIT_MS = 400;

const loaded = new Map<string, ImageSizes>();
const inflight = new Map<string, Promise<ImageSizes>>();

export function peekImageSizes(snapshotId: string | undefined): ImageSizes | undefined {
  return snapshotId ? loaded.get(snapshotId) : undefined;
}

export function loadImageSizes(snapshotId: string): Promise<ImageSizes> {
  const done = loaded.get(snapshotId);
  if (done) return Promise.resolve(done);
  const running = inflight.get(snapshotId);
  if (running) return running;
  const task = fetch(`/api/review-image-sizes?snapshot=${encodeURIComponent(snapshotId)}`)
    .then((response) => (response.ok ? response.json() : { sizes: {} }))
    .then((body: { sizes?: ImageSizes }) => body.sizes ?? {})
    .catch(() => ({}) as ImageSizes)
    .then((sizes) => {
      loaded.clear();
      loaded.set(snapshotId, sizes);
      inflight.delete(snapshotId);
      return sizes;
    });
  inflight.set(snapshotId, task);
  return task;
}

export function resetImageSizesForTests(): void {
  loaded.clear();
  inflight.clear();
}

export function useImageSizesReady(snapshotId: string | undefined, needed: boolean): boolean {
  const [ready, setReady] = useState(() => !needed || !snapshotId || loaded.has(snapshotId));
  useEffect(() => {
    if (!needed || !snapshotId || loaded.has(snapshotId)) {
      setReady(true);
      return;
    }
    setReady(false);
    let live = true;
    const timer = setTimeout(() => live && setReady(true), IMAGE_SIZES_WAIT_MS);
    loadImageSizes(snapshotId).then(() => {
      if (live) setReady(true);
    });
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [snapshotId, needed]);
  return ready;
}
