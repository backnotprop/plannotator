import { useEffect, useRef, useState } from 'react';
import {
  fetchReviewImage,
  peekReviewImage,
  retainReviewImageUrl,
  type ReviewImageData,
  type ReviewImageError,
  type ReviewImageSide,
} from '../../utils/reviewImage';
import type { DiffFileStatus } from '../../types';
import { MAX_REVIEW_IMAGE_PREVIEW_BYTES, oversizedReviewStubBytes } from '@plannotator/core/diff-paths';

export function knownTooLarge(patch: string | undefined, knownBytes?: Partial<Record<ReviewImageSide, number>>): Partial<Record<ReviewImageSide, number>> {
  const sizes = patch ? oversizedReviewStubBytes(patch) : null;
  const out: Partial<Record<ReviewImageSide, number>> = {};
  for (const side of ['old', 'new'] as const) {
    const bytes = sizes?.[side] ?? knownBytes?.[side];
    if (typeof bytes === 'number' && bytes > MAX_REVIEW_IMAGE_PREVIEW_BYTES) out[side] = bytes;
  }
  return out;
}

export type SideState =
  | { state: 'loading' }
  | { state: 'ok'; image: ReviewImageData }
  | { state: 'error'; error: ReviewImageError };

export const sidesFor = (status: DiffFileStatus): ReviewImageSide[] =>
  status === 'added' ? ['new'] : status === 'deleted' ? ['old'] : ['old', 'new'];

function initialState(snapshotId: string | undefined, path: string, side: ReviewImageSide, tooLarge?: number): SideState {
  if (tooLarge !== undefined) return { state: 'error', error: { status: 413, reason: 'too-large', bytes: tooLarge } };
  const cached = snapshotId ? peekReviewImage(snapshotId, path, side) : undefined;
  return cached ? { state: 'ok', image: cached } : { state: 'loading' };
}

export function useNearViewport(): [React.RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (visible || !el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);
  return [ref, visible];
}

export function useImageSides(options: { snapshotId?: string; filePath: string; status: DiffFileStatus; visible: boolean; patch?: string; knownBytes?: Partial<Record<ReviewImageSide, number>> }) {
  const { snapshotId, filePath, status, visible } = options;
  const tooLarge = knownTooLarge(options.patch, options.knownBytes);
  const [states, setStates] = useState<Record<ReviewImageSide, SideState>>(() => ({
    old: initialState(snapshotId, filePath, 'old', tooLarge.old),
    new: initialState(snapshotId, filePath, 'new', tooLarge.new),
  }));

  const oldUrl = states.old.state === 'ok' ? states.old.image.url : undefined;
  const newUrl = states.new.state === 'ok' ? states.new.image.url : undefined;
  useEffect(() => (oldUrl ? retainReviewImageUrl(oldUrl) : undefined), [oldUrl]);
  useEffect(() => (newUrl ? retainReviewImageUrl(newUrl) : undefined), [newUrl]);

  const sidesKey = sidesFor(status).filter((side) => tooLarge[side] === undefined).join(',');
  useEffect(() => {
    if (!snapshotId || !visible || !sidesKey) return;
    const controller = new AbortController();
    for (const side of sidesKey.split(',') as ReviewImageSide[]) {
      const cached = peekReviewImage(snapshotId, filePath, side);
      if (cached) {
        setStates((prev) => (prev[side].state === 'ok' && prev[side].image.url === cached.url ? prev : { ...prev, [side]: { state: 'ok', image: cached } }));
        continue;
      }
      setStates((prev) => ({ ...prev, [side]: { state: 'loading' } }));
      fetchReviewImage(snapshotId, filePath, side, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return;
          setStates((prev) => ({ ...prev, [side]: result.ok ? { state: 'ok', image: result.image } : { state: 'error', error: result.error } }));
        })
        .catch(() => undefined);
    }
    return () => controller.abort();
  }, [snapshotId, filePath, sidesKey, visible]);

  const markDecodeError = (side: ReviewImageSide) =>
    setStates((prev) => ({ ...prev, [side]: { state: 'error', error: { status: 200, reason: 'decode' } } }));

  return { states, markDecodeError };
}
