import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { fitViewport, paddingInset, type FitAxis, type ZoomSize } from '@plannotator/ui/components/imageZoom';
import { readInboxAttachmentKind, type InboxAttachmentState } from '@plannotator/core/inbox-types';
import { WIDE_IMAGE_RATIO } from '../attachments';
import { SWIPE_PEEK_GAP, useSwipePhase, type FileSwipe } from '../fileSwipe';
import type { AttachmentStep } from '../stepping';

/** Where a neighbour is drawn beside the image: just past either edge, or over it while the step lands. */
export type PeekPlace = 'previous' | 'next' | 'cover';

/** The stage a picture is drawn on: the image's own stage (`.ib-imgstage`), where it sits in the area, its size and its padding. */
interface StageBox {
  left: number;
  top: number;
  width: number;
  height: number;
  pad: number;
}

/** Fit's place of an image on a stage, as the image view lays it out (ImageAttachmentView: `fitAxis`, the stage's padding). */
export function peekFit(natural: ZoomSize, stage: StageBox): { left: number; top: number; width: number; height: number } {
  const wide = natural.width > natural.height * WIDE_IMAGE_RATIO;
  const tall = natural.height > natural.width * 2;
  const axis: FitAxis = wide ? 'height' : tall ? 'width' : 'contain';
  const size = { width: stage.width, height: stage.height };
  const view = fitViewport(natural, size, paddingInset(size, stage.pad), axis);
  return { left: view.x, top: view.y, width: natural.width * view.scale, height: natural.height * view.scale };
}

/** A step a swipe can draw whole beside the image: an image. */
export function isImageStep(step: AttachmentStep): boolean {
  return readInboxAttachmentKind(step.attachment.kind) === 'image';
}

function readStage(area: HTMLElement | null): StageBox | null {
  const stage = area?.querySelector<HTMLElement>('.ib-imgstage');
  if (!area || !stage) return null;
  const pad = parseFloat(getComputedStyle(stage).paddingTop);
  const at = stage.getBoundingClientRect();
  const from = area.getBoundingClientRect();
  return { left: at.left - from.left, top: at.top - from.top, width: stage.clientWidth, height: stage.clientHeight, pad: Number.isFinite(pad) ? pad : 0 };
}

/**
 * The images beside the one on screen, for a phone's swipe between images
 * (approval "inbox-image-swipe", "Follow the finger"): each neighbour that is
 * an image is drawn whole at its Fit, `SWIPE_PEEK_GAP` past the edge it comes
 * from, in one layer over the image's stage (`.ib-imgpeeks`) that the swipe
 * moves with the picture, so it comes in with the finger while the size bar
 * and the comment box stay put. Once a step
 * lands, the image stepped to stays drawn over the area (`cover`) until the
 * new image is on screen (`swipe.settle`), so nothing blinks between them.
 * Drawn all the time the swipe is on, so the neighbours are loaded before a
 * swipe needs them. It redraws when the swipe's phase changes, never while
 * the finger moves. Hidden from screen readers (the step is said in the
 * pane's live region).
 */
export function ImageSwipePeek({
  swipe,
  steps,
  index,
  area,
  urlOf,
}: {
  swipe: FileSwipe;
  steps: readonly AttachmentStep[];
  index: number;
  /** The swiping area (the pane's `.ib-docarea`): the stage is read from it. */
  area: RefObject<HTMLElement | null>;
  urlOf: (attachment: InboxAttachmentState) => string;
}) {
  const progress = useSwipePhase(swipe);
  // The image a committed swipe is bringing in: the cover while the step lands.
  const incoming = useRef<AttachmentStep | null>(null);
  if (progress?.phase === 'slide') incoming.current = steps[index + progress.dir] ?? null;
  else if (progress?.phase !== 'handoff') incoming.current = null;
  const cover = progress?.phase === 'handoff' ? incoming.current : null;

  const [stage, setStage] = useState<StageBox | null>(null);
  const swiping = progress !== null;
  const read = () => {
    const next = readStage(area.current);
    if (next) setStage((was) => (was && was.left === next.left && was.top === next.top && was.width === next.width && was.height === next.height && was.pad === next.pad ? was : next));
  };
  const readRef = useRef(read);
  readRef.current = read;
  // The stage is read whenever the pane draws while no swipe is under way (the image view may come in after this
  // does), so the neighbours are drawn, and loaded, before the finger needs them; never while the finger moves.
  useLayoutEffect(() => {
    if (!swiping) readRef.current();
  });
  useLayoutEffect(() => {
    const onResize = () => readRef.current();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const isImage = (step: AttachmentStep | undefined): step is AttachmentStep => step !== undefined && isImageStep(step);
  const shown: { step: AttachmentStep; place: PeekPlace }[] = [];
  if (cover) shown.push({ step: cover, place: 'cover' });
  const prev = steps[index - 1];
  const next = steps[index + 1];
  if (isImage(prev) && prev.attachment.id !== cover?.attachment.id) shown.push({ step: prev, place: 'previous' });
  if (isImage(next) && next.attachment.id !== cover?.attachment.id) shown.push({ step: next, place: 'next' });
  if (!stage || shown.length === 0) return null;
  return (
    <div className="ib-imgpeeks" aria-hidden="true" data-image-peeks="" style={{ left: stage.left, top: stage.top, width: stage.width, height: stage.height }}>
      {shown.map(({ step, place }) => (
        <PeekImage key={step.attachment.id} src={urlOf(step.attachment)} place={place} stage={stage} />
      ))}
    </div>
  );
}

function PeekImage({ src, place, stage }: { src: string; place: PeekPlace; stage: StageBox }) {
  const [natural, setNatural] = useState<ZoomSize | null>(null);
  const left = place === 'cover' ? 0 : place === 'next' ? `calc(100% + ${SWIPE_PEEK_GAP}px)` : `calc(-100% - ${SWIPE_PEEK_GAP}px)`;
  const box = natural ? peekFit(natural, stage) : null;
  return (
    <div className="ib-imgpeek" data-image-peek={place} style={{ left, height: stage.height }}>
      <img
        src={src}
        alt=""
        draggable={false}
        onLoad={(event) => {
          const img = event.currentTarget;
          if (img.naturalWidth > 0) setNatural({ width: img.naturalWidth, height: img.naturalHeight });
        }}
        style={box ? { left: box.left, top: box.top, width: box.width, height: box.height } : { visibility: 'hidden' }}
      />
    </div>
  );
}
