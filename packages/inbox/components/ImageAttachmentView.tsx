import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';
import { ImageAnnotator } from '@plannotator/ui/components/ImageAnnotator';
import { getImageSrc } from '@plannotator/ui/components/ImageThumbnail';
import type { Annotation, ImageAttachment } from '@plannotator/ui/types';
import { InboxApiError, inboxApi } from '../api';
import { attachmentImageUrl, imageCommentAnnotation, WIDE_IMAGE_RATIO } from '../attachments';
import { Icon } from '../icons';

/** A fresh annotation id. */
function newId(): string {
  return typeof crypto.randomUUID === 'function' ? `ann-img-${crypto.randomUUID()}` : `ann-img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function stem(name: string): string {
  return name.replace(/\.[^.]+$/, '') || name;
}

/**
 * An image attachment in the pane: the image on a quiet stage (fit to the
 * pane, a click shows it at its own size), and a comment box under it. "Mark
 * up" opens Plannotator's image annotator (pen, arrow, circle) on the image;
 * the drawing is kept by the Inbox and rides the comment, so the agent can
 * open the marked-up copy. Selecting a comment with a drawing shows it on the
 * stage. The image is drawn only by `<img src>` from the attachment's route.
 *
 * The pane keys it by attachment, so the comment box is never carried to the
 * next file. Stepping: the pane remembers Fit / Actual size per file
 * (`initialFit`, `onFitChange`); an image at its own size that overflows
 * keeps the arrow keys (`data-claims-arrows`); a horizontal swipe on the
 * image shown fitted steps (`onSwipe`), nowhere else.
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
}) {
  const [fit, setFit] = useState<'fit' | 'actual'>(initialFit ?? 'fit');
  // The pane remembers the size per file: told after each change, never from inside a state update.
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
  const [text, setText] = useState('');
  const [markup, setMarkup] = useState<ImageAttachment | null>(null);
  const [annotating, setAnnotating] = useState(false);
  const [saving, setSaving] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const src = attachmentImageUrl(attachment, version);

  // Another version of the same file: fitted again.
  const shownVersion = useRef(version);
  useEffect(() => {
    if (shownVersion.current === version) return;
    shownVersion.current = version;
    setFit('fit');
    setNatural(null);
    setFailed(false);
  }, [version]);

  // A panorama fitted to the pane would be a sliver: it keeps a readable height and scrolls sideways.
  const wide = natural !== null && natural.width > natural.height * WIDE_IMAGE_RATIO;
  // At its own size (or a panorama) and larger than the stage, the image scrolls with the arrows (they do not step).
  const stageRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  // An image no larger than the stage is shown at its own size either way: nothing to zoom (`.ib-noup`).
  const [fitsStage, setFitsStage] = useState(false);
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      const style = getComputedStyle(stage);
      const room = {
        width: stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        height: stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
      };
      setFitsStage(natural !== null && room.width > 0 && natural.width <= room.width && natural.height <= room.height);
      setOverflows((fit === 'actual' || wide) && (stage.scrollWidth > stage.clientWidth + 1 || stage.scrollHeight > stage.clientHeight + 1));
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(stage);
    return () => observer?.disconnect();
  }, [fit, natural, wide]);

  // A horizontal swipe on the fitted image: more than 60 px across, less than 40 px up or down (a panorama scrolls instead).
  const swipeStart = useRef<{ x: number; y: number } | null>(null);
  const swipes = onSwipe !== undefined && fit === 'fit' && !wide;

  // A selected comment that carries a drawing shows the drawing on the stage.
  const selected = selectedId ? annotations.find((a) => a.id === selectedId) : undefined;
  const selectedMarkup = selected?.images?.[0] ?? null;
  const [showOriginal, setShowOriginal] = useState(false);
  useEffect(() => setShowOriginal(false), [selectedId]);
  const showingMarkup = selectedMarkup !== null && !showOriginal;
  const stageSrc = showingMarkup ? getImageSrc(selectedMarkup!.path) : src;

  const tall = natural !== null && natural.height > natural.width * 2;
  const canZoom = natural !== null;

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
        className={`ib-imgstage${swipes ? ' ib-swipes' : ''}`}
        ref={stageRef}
        data-fit={fit}
        data-tall={tall ? 'true' : 'false'}
        data-wide={wide ? 'true' : undefined}
        data-src={stageSrc}
        data-claims-arrows={overflows ? 'true' : undefined}
        onTouchStart={
          swipes
            ? (event) => {
                const touch = event.touches[0];
                swipeStart.current = event.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY } : null;
              }
            : undefined
        }
        onTouchEnd={
          swipes
            ? (event) => {
                const start = swipeStart.current;
                swipeStart.current = null;
                const touch = event.changedTouches[0];
                if (!start || !touch) return;
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
          <button
            type="button"
            className="ib-btn ib-ghost ib-sm"
            onClick={() => setFit((v) => (v === 'fit' ? 'actual' : 'fit'))}
            disabled={!canZoom}
            aria-pressed={fit === 'actual'}
            title={fit === 'fit' ? 'Show the image at its own size' : 'Fit the image to the pane'}
          >
            <Icon name={fit === 'fit' ? 'expand' : 'collapse'} size={13} />
            {fit === 'fit' ? 'Actual size' : 'Fit'}
          </button>
        </div>
        {failed ? (
          <div className="ib-error" role="alert" style={{ alignSelf: 'center' }}>
            This image could not be shown. Download it from the header to open it elsewhere.
          </div>
        ) : (
          <img
            key={stageSrc}
            className={fit === 'fit' && fitsStage ? 'ib-noup' : undefined}
            src={stageSrc}
            alt={showingMarkup ? `${attachment.name}, marked up` : attachment.name}
            draggable={false}
            decoding="async"
            onLoad={(event) => {
              if (showingMarkup) return;
              const img = event.currentTarget;
              setNatural({ width: img.naturalWidth, height: img.naturalHeight });
            }}
            onError={() => {
              if (!showingMarkup) setFailed(true);
            }}
            onClick={() => canZoom && setFit((v) => (v === 'fit' ? 'actual' : 'fit'))}
          />
        )}
      </div>
      {!readOnly && (
        <div className="ib-imgcompose" data-image-composer="">
          {markup && (
            <span className="ib-markup" title="Your marked-up copy rides this comment">
              <img src={getImageSrc(markup.path)} alt="Your marked-up copy" />
              <button type="button" onClick={() => setMarkup(null)} aria-label="Remove the marked-up copy">
                <Icon name="x" size={10} />
              </button>
            </span>
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
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.stopPropagation();
                void submit();
              }
            }}
          />
          <button type="button" className="ib-btn" onClick={() => setAnnotating(true)} disabled={failed} title="Draw on the image (pen, arrow, circle)" data-markup-open="">
            <Icon name="pen" size={14} />
            {markup ? 'Redraw' : 'Mark up'}
          </button>
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
            const kept = await inboxApi.uploadMarkup(blob);
            setMarkup({ path: kept.path, name: `${stem(attachment.name)}, marked up` });
          } catch (cause) {
            onError(cause instanceof InboxApiError ? cause.message : 'The drawing was not kept.');
          }
        }}
      />
    </div>
  );
}
