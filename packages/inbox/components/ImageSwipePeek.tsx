import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { fitViewport, paddingInset, type FitAxis, type ZoomClear, type ZoomSize } from '@plannotator/ui/components/imageZoom';
import { readInboxAttachmentKind, type InboxAttachmentState } from '@plannotator/core/inbox-types';
import { WIDE_IMAGE_RATIO } from '../attachments';
import { SWIPE_PEEK_GAP, useSwipePhase, type FileSwipe } from '../fileSwipe';
import { useClearRows } from '../imageClear';
import type { AttachmentStep } from '../stepping';

export type PeekPlace = 'previous' | 'next' | 'cover';

interface StageBox {
  left: number;
  top: number;
  width: number;
  height: number;
  pad: number;
}

export function peekFit(natural: ZoomSize, stage: StageBox, clear?: ZoomClear): { left: number; top: number; width: number; height: number } {
  const wide = natural.width > natural.height * WIDE_IMAGE_RATIO;
  const tall = natural.height > natural.width * 2;
  const axis: FitAxis = wide ? 'height' : tall ? 'width' : 'contain';
  const top = clear?.top ?? 0;
  const size = { width: stage.width, height: stage.height - top - (clear?.bottom ?? 0) };
  const view = fitViewport(natural, size, paddingInset(size, stage.pad), axis);
  return { left: view.x, top: view.y + top, width: natural.width * view.scale, height: natural.height * view.scale };
}

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
  area: RefObject<HTMLElement | null>;
  urlOf: (attachment: InboxAttachmentState) => string;
}) {
  const progress = useSwipePhase(swipe);
  const incoming = useRef<AttachmentStep | null>(null);
  if (progress?.phase === 'slide') incoming.current = steps[index + progress.dir] ?? null;
  else if (progress?.phase !== 'handoff') incoming.current = null;
  const cover = progress?.phase === 'handoff' ? incoming.current : null;

  const [stage, setStage] = useState<StageBox | null>(null);
  const { probe, clear } = useClearRows();
  const swiping = progress !== null;
  const read = () => {
    const next = readStage(area.current);
    if (next) setStage((was) => (was && was.left === next.left && was.top === next.top && was.width === next.width && was.height === next.height && was.pad === next.pad ? was : next));
  };
  const readRef = useRef(read);
  readRef.current = read;
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
      <div className="ib-imgclear" ref={probe} />
      {shown.map(({ step, place }) => (
        <PeekImage key={place === 'next' && prev?.attachment.id === step.attachment.id ? `${step.attachment.id}:next` : step.attachment.id} src={urlOf(step.attachment)} place={place} stage={stage} clear={clear} />
      ))}
    </div>
  );
}

function PeekImage({ src, place, stage, clear }: { src: string; place: PeekPlace; stage: StageBox; clear?: ZoomClear }) {
  const [natural, setNatural] = useState<ZoomSize | null>(null);
  const left = place === 'cover' ? 0 : place === 'next' ? `calc(100% + ${SWIPE_PEEK_GAP}px)` : `calc(-100% - ${SWIPE_PEEK_GAP}px)`;
  const box = natural ? peekFit(natural, stage, clear) : null;
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
