import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ImageZoomStage, type FitAxis, type ImageZoomStageHandle, type WheelHintGate, type ZoomMode } from '@plannotator/ui/components/ImageZoomStage';
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';
import { ImageAnnotator } from '@plannotator/ui/components/ImageAnnotator';
import { getImageSrc } from '@plannotator/ui/components/ImageThumbnail';
import type { Annotation, ImageAttachment } from '@plannotator/ui/types';
import { InboxApiError } from '../api';
import { imageCommentAnnotation, WIDE_IMAGE_RATIO } from '../attachments';
import { useInboxFileSource } from '../fileSource';
import { Icon } from '../icons';
import { PHONE_QUERY } from '../phone';
import { Tip } from './Tip';
import { useConfigValue } from '@plannotator/ui/config';
import { isCommentSubmitKey } from '@plannotator/ui/utils/commentSubmitKey';

/** A fresh annotation id. */
function newId(): string {
  return typeof crypto.randomUUID === 'function' ? `ann-img-${crypto.randomUUID()}` : `ann-img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function stem(name: string): string {
  return name.replace(/\.[^.]+$/, '') || name;
}

/** The scale beside Fit / Actual size: "37%", "250%". */
export function zoomPercent(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

/**
 * An image attachment in the pane: the image on a quiet stage, and a comment
 * box under it. The stage is ui's `ImageZoomStage`, the lightbox's: Ctrl/⌘ +
 * wheel and a trackpad pinch zoom about the pointer, a plain wheel scrolls an
 * image larger than the stage (and zooms one that fits), a drag or one finger
 * pans, two fingers pinch, a double click toggles Fit and 2×, Fit to 800%.
 * The size bar shows the scale beside Fit / Actual size, which reset it.
 * Transforms only, so a gesture never lays anything out. "Mark up" opens
 * Plannotator's image annotator (pen, arrow, circle) on the image; the
 * drawing is kept by the Inbox and rides the comment, so the agent can open
 * the marked-up copy. Selecting a comment with a drawing lays the drawing
 * over the image in the image's own transform, so it stays aligned at any
 * zoom. The image is drawn only by `<img src>` from the attachment's route.
 *
 * The pane keys it by attachment, so the comment box is never carried to the
 * next file and every file opens at Fit, except one the reader set to Actual
 * size (the pane remembers that per file: `initialFit`, `onFitChange`; a
 * gesture's zoom is not remembered). A tall screenshot fits its width (read
 * from the top) and a panorama its height (read from the left); pinch out
 * shows the whole image. ← → and ] [ always step files, zoomed or not: the
 * focused stage takes only ↑ ↓, Page Up / Down, Home / End and Space to pan.
 * A horizontal swipe on the image shown at Fit steps (`onSwipe`), nowhere else.
 */
export function ImageAttachmentView({
  attachment,
  version,
  annotations,
  selectedId,
  readOnly,
  onSave,
  onError,
  initialFit,
  onFitChange,
  onSwipe,
  wheelHint,
  suggestion,
}: {
  attachment: InboxAttachmentState;
  version: 'current' | 'sent';
  annotations: readonly Annotation[];
  selectedId: string | null;
  readOnly: boolean;
  onSave: (annotation: Annotation) => Promise<boolean>;
  onError: (message: string) => void;
  /** Fit or Actual size when it opens (the pane's memory of this file). */
  initialFit?: 'fit' | 'actual';
  onFitChange?: (fit: 'fit' | 'actual') => void;
  /** A swipe across the fitted image: 1 next file, -1 previous. */
  onSwipe?: (dir: 1 | -1) => void;
  /** The pane's "⌘ + scroll to zoom" gate, so the hint shows once per viewer open, not once per file (#2127). */
  wheelHint?: WheelHintGate;
  /** A suggested comment the box opens with (the tour's): kept with one press, or written over. */
  suggestion?: string;
}) {
  const [mode, setMode] = useState<ZoomMode>(initialFit ?? 'fit');
  const [scale, setScale] = useState<number | null>(null);
  const enterSavesComment = useConfigValue('enterSavesComment');
  // The pane remembers Fit / Actual size per file: told after each change, never from inside a state update. A gesture's zoom counts as Fit.
  const fit: 'fit' | 'actual' = mode === 'actual' ? 'actual' : 'fit';
  const reportedFit = useRef(fit);
  const onFitChangeRef = useRef(onFitChange);
  onFitChangeRef.current = onFitChange;
  useEffect(() => {
    if (reportedFit.current === fit) return;
    reportedFit.current = fit;
    onFitChangeRef.current?.(fit);
  }, [fit]);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [text, setText] = useState(suggestion ?? '');
  const [markup, setMarkup] = useState<ImageAttachment | null>(null);
  const [annotating, setAnnotating] = useState(false);
  const [saving, setSaving] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const zoomRef = useRef<ImageZoomStageHandle>(null);
  const source = useInboxFileSource();
  const src = source.imageUrl(attachment, version);

  // Another version of the same file: fitted again.
  const shownVersion = useRef(version);
  useEffect(() => {
    if (shownVersion.current === version) return;
    shownVersion.current = version;
    setMode('fit');
    setScale(null);
    setNatural(null);
    setFailed(false);
  }, [version]);

  // A panorama fitted to the pane would be a sliver: Fit keeps a readable height (read from the left); a tall screenshot fits its width (read from the top).
  const wide = natural !== null && natural.width > natural.height * WIDE_IMAGE_RATIO;
  const tall = natural !== null && natural.height > natural.width * 2;
  const fitAxis: FitAxis = wide ? 'height' : tall ? 'width' : 'contain';

  // The stage's own padding (28 px, 12 on a phone) is what Fit leaves around the image.
  const stageRef = useRef<HTMLDivElement>(null);
  const [pad, setPad] = useState<number | null>(null);
  // Read again when the phone breakpoint is crossed (the padding changes with it).
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const read = () => {
      const value = parseFloat(getComputedStyle(stage).paddingTop);
      setPad(Number.isFinite(value) ? value : 0);
    };
    read();
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(PHONE_QUERY);
    query.addEventListener?.('change', read);
    return () => query.removeEventListener?.('change', read);
  }, []);

  // Ctrl + wheel (a pinch) and Safari's gesture events over the size bar or the
  // chip must not zoom the page; the stage zooms the image from its own listeners.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) event.preventDefault();
    };
    const onGesture = (event: Event) => event.preventDefault();
    stage.addEventListener('wheel', onWheel, { passive: false });
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) stage.addEventListener(type, onGesture, { passive: false });
    return () => {
      stage.removeEventListener('wheel', onWheel);
      for (const type of ['gesturestart', 'gesturechange', 'gestureend']) stage.removeEventListener(type, onGesture);
    };
  }, []);

  // A horizontal swipe on the image at Fit: more than 60 px across, less than 40 px up or down (a panorama pans instead).
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const swipes = onSwipe !== undefined && mode === 'fit' && !wide;

  // A selected comment that carries a drawing shows the drawing over the image.
  const selected = selectedId ? annotations.find((a) => a.id === selectedId) : undefined;
  const selectedMarkup = selected?.images?.[0] ?? null;
  const [showOriginal, setShowOriginal] = useState(false);
  useEffect(() => setShowOriginal(false), [selectedId]);
  const showingMarkup = selectedMarkup !== null && !showOriginal && !failed;
  const markupSrc = showingMarkup ? getImageSrc(selectedMarkup!.path) : null;

  const submit = async () => {
    const words = text.trim();
    if ((!words && !markup) || saving) return;
    setSaving(true);
    const ok = await onSave(
      imageCommentAnnotation({
        id: newId(),
        name: attachment.name,
        text: words || 'See the marked-up image.',
        markup,
      }),
    );
    setSaving(false);
    if (ok) {
      setText('');
      setMarkup(null);
    }
  };

  return (
    <div className="ib-imgview" data-image-view={attachment.id}>
      <div
        className="ib-imgstage"
        ref={stageRef}
        data-fit={mode}
        data-tall={tall ? 'true' : 'false'}
        data-wide={wide ? 'true' : undefined}
        data-src={markupSrc ?? src}
        onKeyDown={(event) => {
          // The focused stage pans with the browser's scroll keys; ← → stay stepping.
          const zoom = zoomRef.current;
          if (!zoom?.element || event.target !== zoom.element) return;
          if (event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent.isComposing) return;
          if (zoom.scrollKey(event.key, event.shiftKey, false)) event.preventDefault();
        }}
        onTouchStart={
          swipes
            ? (event) => {
                const touch = event.touches[0];
                swipeStart.current = event.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY } : null;
              }
            : undefined
        }
        onTouchMove={
          swipes
            ? (event) => {
                // A second finger is a pinch, never a swipe.
                if (event.touches.length > 1) swipeStart.current = null;
              }
            : undefined
        }
        onTouchEnd={
          swipes
            ? (event) => {
                const start = swipeStart.current;
                swipeStart.current = null;
                const touch = event.changedTouches[0];
                if (!start || !touch || event.touches.length > 0) return;
                const dx = touch.clientX - start.x;
                const dy = touch.clientY - start.y;
                if (Math.abs(dx) > 60 && Math.abs(dy) < 40) onSwipe!(dx < 0 ? 1 : -1);
              }
            : undefined
        }
      >
        {showingMarkup && (
          <div className="ib-imgshowing" data-showing-markup="">
            <Icon name="pen" size={13} />
            Your marked-up copy
            <button type="button" className="ib-vlink" onClick={() => setShowOriginal(true)}>
              Show the image
            </button>
          </div>
        )}
        <div className="ib-imgbar">
          {natural && <span className="ib-imgsize">{`${natural.width} × ${natural.height}`}</span>}
          {natural && scale !== null && (
            <span className="ib-imgsize ib-imgzoom" data-image-zoom="">
              <span className="sr-only">Zoom </span>
              {zoomPercent(scale)}
            </span>
          )}
          <Tip content={mode === 'fit' ? 'Show the image at its own size' : 'Fit the image to the pane'}>
            <button
              type="button"
              className="ib-btn ib-ghost ib-sm"
              onClick={() => setMode((v) => (v === 'fit' ? 'actual' : 'fit'))}
              disabled={!natural}
              aria-pressed={mode !== 'fit'}
              data-image-fit=""
            >
              <Icon name={mode === 'fit' ? 'expand' : 'collapse'} size={13} />
              {mode === 'fit' ? 'Actual size' : 'Fit'}
            </button>
          </Tip>
        </div>
        {failed ? (
          <div className="ib-error" role="alert" style={{ alignSelf: 'center' }}>
            This image could not be shown. Download it from the header to open it elsewhere.
          </div>
        ) : (
          pad !== null && (
            <ImageZoomStage
              ref={zoomRef}
              key={src}
              src={src}
              alt={attachment.name}
              label={`Image: ${attachment.name}`}
              mode={mode}
              onModeChange={setMode}
              onScaleChange={setScale}
              padding={pad}
              fitAxis={fitAxis}
              radius={4}
              className="ib-zoomstage"
              imageClassName="ib-zoomimg"
              stageAttributes={{ 'data-image-zoom-stage': mode }}
              wheelHint={wheelHint}
              onImageLoad={setNatural}
              onImageError={() => setFailed(true)}
              overlay={
                markupSrc ? <img className="ib-zoommarkup" src={markupSrc} alt={`${attachment.name}, marked up`} draggable={false} data-markup-overlay="" /> : null
              }
            />
          )
        )}
      </div>
      {!readOnly && (
        <div className="ib-imgcompose" data-image-composer="">
          {markup && (
            <Tip content="Your marked-up copy rides this comment">
              <span className="ib-markup">
                <img src={getImageSrc(markup.path)} alt="Your marked-up copy" />
                <button type="button" onClick={() => setMarkup(null)} aria-label="Remove the marked-up copy">
                  <Icon name="x" size={10} />
                </button>
              </span>
            </Tip>
          )}
          <textarea
            ref={textRef}
            className="ib-ta"
            rows={1}
            value={text}
            placeholder={markup ? 'What should change?' : 'Comment on this image…'}
            aria-label={`Comment on ${attachment.name}`}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (isCommentSubmitKey(event, enterSavesComment)) {
                event.preventDefault();
                event.stopPropagation();
                void submit();
              }
            }}
          />
          <Tip content="Draw on the image (pen, arrow, circle)">
            <button type="button" className="ib-btn" onClick={() => setAnnotating(true)} disabled={failed} data-markup-open="">
              <Icon name="pen" size={14} />
              {markup ? 'Redraw' : 'Mark up'}
            </button>
          </Tip>
          <button type="button" className="ib-btn ib-pri" onClick={() => void submit()} disabled={saving || (!text.trim() && !markup)} data-image-comment-save="">
            Comment
          </button>
        </div>
      )}
      <ImageAnnotator
        imageSrc={src}
        isOpen={annotating}
        onClose={() => {
          setAnnotating(false);
          requestAnimationFrame(() => textRef.current?.focus());
        }}
        onAccept={async (blob, hasDrawings) => {
          // Nothing drawn: nothing to keep; the comment box stays as it was.
          if (!hasDrawings) return;
          try {
            const kept = await source.keepMarkup(blob);
            setMarkup({ path: kept.path, name: `${stem(attachment.name)}, marked up` });
          } catch (cause) {
            onError(cause instanceof InboxApiError ? cause.message : 'The drawing was not kept.');
          }
        }}
      />
    </div>
  );
}
