import { useContext, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';
import { ImageZoomStage, type FitAxis, type ImageZoomStageHandle, type WheelHintGate, type ZoomMode } from '@plannotator/ui/components/ImageZoomStage';
import { canPanToward } from '@plannotator/ui/components/imageZoom';
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';
import { ImageAnnotator } from '@plannotator/ui/components/ImageAnnotator';
import { getImageSrc } from '@plannotator/ui/components/ImageThumbnail';
import type { Annotation, ImageAttachment } from '@plannotator/ui/types';
import { InboxApiError } from '../api';
import { imageCommentAnnotation, WIDE_IMAGE_RATIO } from '../attachments';
import { useInboxFileSource } from '../fileSource';
import { Icon } from '../icons';
import { useClearRows } from '../imageClear';
import { PHONE_QUERY } from '../phone';
import { Tip } from './Tip';
import { useConfigValue } from '@plannotator/ui/config';
import { isCommentSubmitKey } from '@plannotator/ui/utils/commentSubmitKey';
import { markupWords, noteOnto } from '../markup';
import { DRAWING_SCREEN, KeptMarkup, markupAddedToast, OverWindow, type Notice } from './Markup';
import { FullScreenCommentBin, FullScreenComposer, FullScreenComposerContext } from './FullScreenComposer';
import { useRowDraft } from '../fileCommentDrafts';
import { markImageComposer } from '../pageMarks';

function newId(): string {
  return typeof crypto.randomUUID === 'function' ? `ann-img-${crypto.randomUUID()}` : `ann-img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function stem(name: string): string {
  return name.replace(/\.[^.]+$/, '') || name;
}

export interface ImageSwipeEdges {
  keeps(dir: 1 | -1): boolean;
  canDismiss(): boolean;
}

export function zoomPercent(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

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
  edgesRef,
  onShown,
  wheelHint,
  suggestion,
  onSelect,
  onRemove,
  onNotice,
}: {
  attachment: InboxAttachmentState;
  version: 'current' | 'sent';
  annotations: readonly Annotation[];
  selectedId: string | null;
  readOnly: boolean;
  onSave: (annotation: Annotation) => Promise<boolean>;
  onError: (message: string) => void;
  initialFit?: 'fit' | 'actual';
  onFitChange?: (fit: 'fit' | 'actual') => void;
  onSwipe?: (dir: 1 | -1) => void;
  edgesRef?: MutableRefObject<ImageSwipeEdges | null>;
  onShown?: () => void;
  wheelHint?: WheelHintGate;
  suggestion?: string;
  onSelect?: (id: string | null) => void;
  onRemove?: (id: string) => Promise<void> | void;
  onNotice?: Notice;
}) {
  const composer = useContext(FullScreenComposerContext);
  const [mode, setMode] = useState<ZoomMode>(initialFit ?? 'fit');
  const [scale, setScale] = useState<number | null>(null);
  const enterSavesComment = useConfigValue('enterSavesComment');
  // Told after each change, never from inside a state update.
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
  const waiting = useRowDraft(() => (readOnly || sentWords.current === text ? null : { kind: 'row', text, markup }));
  const [text, setText] = useState(waiting?.text ?? suggestion ?? '');
  const [markup, setMarkup] = useState<ImageAttachment | null>(waiting?.markup ?? null);
  const sentWords = useRef<string | null>(null);
  const sendRow = async (annotation: Annotation) => {
    sentWords.current = text;
    const ok = await onSave(annotation);
    if (!ok) sentWords.current = null;
    return ok;
  };
  const [kept, setKept] = useState<{ id: string; image: ImageAttachment } | null>(null);
  // One drawing per opening of the drawing screen: set as it opens, taken by the first ✓ or Enter. ui calls
  // onAccept once per press, each after its own encode, so a later press (even one landing after the first
  // drawing is in the reply) adds nothing.
  const acceptable = useRef(false);
  const [annotating, setAnnotating] = useState(false);
  useEffect(() => {
    if (annotating) acceptable.current = true;
  }, [annotating]);
  const [saving, setSaving] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const zoomRef = useRef<ImageZoomStageHandle>(null);
  const source = useInboxFileSource();
  const src = source.imageUrl(attachment, version);

  const shownVersion = useRef(version);
  useEffect(() => {
    if (shownVersion.current === version) return;
    shownVersion.current = version;
    setMode('fit');
    setScale(null);
    setNatural(null);
    setFailed(false);
  }, [version]);

  const modeRef = useRef(mode);
  modeRef.current = mode;
  const naturalRef = useRef(natural);
  naturalRef.current = natural;
  useEffect(() => {
    if (!edgesRef) return;
    edgesRef.current = {
      keeps: (dir) => canPanToward(zoomRef.current?.visibleBox() ?? null, naturalRef.current?.width ?? 0, dir),
      canDismiss: () => {
        if (modeRef.current !== 'fit') return false;
        const box = zoomRef.current?.visibleBox() ?? null;
        return box === null || box.y <= 1;
      },
    };
    return () => {
      edgesRef.current = null;
    };
  }, [edgesRef]);
  const onShownRef = useRef(onShown);
  onShownRef.current = onShown;
  useEffect(() => {
    if (!natural && !failed) return;
    const frame = requestAnimationFrame(() => onShownRef.current?.());
    return () => cancelAnimationFrame(frame);
  }, [natural, failed]);

  // A panorama fitted to the pane would be a sliver: Fit keeps a readable height (read from the left); a tall screenshot fits its width (read from the top).
  const wide = natural !== null && natural.width > natural.height * WIDE_IMAGE_RATIO;
  const tall = natural !== null && natural.height > natural.width * 2;
  const fitAxis: FitAxis = wide ? 'height' : tall ? 'width' : 'contain';

  const stageRef = useRef<HTMLDivElement>(null);
  const [pad, setPad] = useState<number | null>(null);
  const { probe: clearProbe, clear } = useClearRows();
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

  // A horizontal swipe at Fit: over 60 px across, under 40 px up or down (a panorama pans instead).
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const swipes = onSwipe !== undefined && mode === 'fit' && !wide;

  const selected = selectedId ? annotations.find((a) => a.id === selectedId) : undefined;
  const selectedMarkup = selected?.images?.[0] ?? null;
  const keptNow = kept ? annotations.find((a) => a.id === kept.id) ?? null : null;
  useEffect(() => {
    if (kept && !keptNow) setKept(null);
  }, [kept, keptNow]);
  const [showOriginal, setShowOriginal] = useState(false);
  useEffect(() => setShowOriginal(false), [selectedId]);
  const showingMarkup = selectedMarkup !== null && !showOriginal && !failed;
  const markupSrc = showingMarkup ? getImageSrc(selectedMarkup!.path) : null;

  const submit = async () => {
    const words = text.trim();
    if (saving) return;
    if (kept && keptNow) {
      if (!words && !markup) return;
      setSaving(true);
      const ok = await sendRow({ ...keptNow, text: noteOnto(keptNow, words), ...(markup ? { images: [markup] } : {}) });
      setSaving(false);
      if (ok) {
        setText('');
        setMarkup(null);
        setKept(null);
      }
      return;
    }
    if (!words && !markup) return;
    setSaving(true);
    const ok = await sendRow(
      imageCommentAnnotation({
        id: newId(),
        name: attachment.name,
        text: markupWords(words, markup !== null),
        markup,
      }),
    );
    setSaving(false);
    if (ok) {
      setText('');
      setMarkup(null);
    }
  };

  const removeKept = (id: string) => {
    setKept((current) => (current?.id === id ? null : current));
    onSelect?.(null);
    void onRemove?.(id);
  };

  const addDrawing = async (image: ImageAttachment) => {
    const words = text.trim();
    const redraw = kept && keptNow ? keptNow : null;
    const id = redraw?.id ?? newId();
    const ok = await sendRow(
      redraw
        ? { ...redraw, text: noteOnto(redraw, words), images: [image] }
        : imageCommentAnnotation({ id, name: attachment.name, text: markupWords(words, true), markup: image }),
    );
    if (!ok) {
      setMarkup(image);
      return;
    }
    setMarkup(null);
    setText('');
    setKept(words ? null : { id, image });
    onSelect?.(id);
    if (!redraw) onNotice?.(markupAddedToast(() => removeKept(id)));
  };

  const commentCard = (
    <div className="ib-ccard">
      {kept && <KeptMarkup image={kept.image} onRedraw={() => setAnnotating(true)} onRemove={() => removeKept(kept.id)} />}
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
        placeholder={kept ? 'Note (optional)' : markup ? 'What should change?' : 'Comment on this image…'}
        aria-label={kept ? `A note with your drawing on ${attachment.name}` : `Comment on ${attachment.name}`}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (isCommentSubmitKey(event, enterSavesComment)) {
            event.preventDefault();
            event.stopPropagation();
            void submit();
            return;
          }
          if (event.key === 'Escape' && !event.nativeEvent.isComposing && !event.defaultPrevented) {
            const paneEl = event.currentTarget.closest<HTMLElement>('[data-attachment-pane]');
            if (!paneEl || paneEl.closest('[data-full-view]')) return;
            event.preventDefault();
            event.stopPropagation();
            paneEl.focus({ preventScroll: true });
          }
        }}
      />
      <Tip content="Draw on the image (pen, arrow, circle)">
        <button type="button" className="ib-btn ib-cbtn" onClick={() => setAnnotating(true)} disabled={failed} data-markup-open="" aria-label={markup || kept ? 'Redraw' : 'Mark up'}>
          <Icon name="pen" size={15} />
          <span className="ib-cbtn-l" aria-hidden="true">
            {markup || kept ? 'Redraw' : 'Mark up'}
          </span>
        </button>
      </Tip>
      <FullScreenCommentBin />
      <button
        type="button"
        className="ib-btn ib-pri ib-csave"
        onClick={() => void submit()}
        disabled={saving || (!text.trim() && !markup)}
        data-image-comment-save=""
      >
        {kept ? 'Add note' : 'Comment'}
      </button>
    </div>
  );

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
        <div className="ib-imgclear" ref={clearProbe} aria-hidden="true" data-image-clear="" />
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
              clear={clear}
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
      {composer ? (
        <FullScreenComposer value={composer} noun="image" comment={readOnly ? null : <div className="ib-fcomp-comment" data-image-composer="">{commentCard}</div>} />
      ) : (
        !readOnly && (
          <div ref={markImageComposer} className="ib-imgcompose" data-image-composer="">
            {commentCard}
          </div>
        )
      )}
      <OverWindow>
        <ImageAnnotator
          imageSrc={src}
          isOpen={annotating}
          escapeCancels={DRAWING_SCREEN.escapeCancels}
          hint={DRAWING_SCREEN.hint}
          onClose={() => {
            setAnnotating(false);
            requestAnimationFrame(() => textRef.current?.focus());
          }}
          onAccept={async (blob, hasDrawings) => {
            if (!hasDrawings || !acceptable.current) return;
            acceptable.current = false;
            try {
              const keptFile = await source.keepMarkup(blob);
              await addDrawing({ path: keptFile.path, name: `${stem(attachment.name)}, marked up` });
            } catch (cause) {
              onError(cause instanceof InboxApiError ? cause.message : 'The drawing was not kept.');
            }
          }}
        />
      </OverWindow>
    </div>
  );
}
