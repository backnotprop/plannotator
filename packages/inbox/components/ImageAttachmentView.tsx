import { useEffect, useRef, useState } from 'react';
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';
import { ImageAnnotator } from '@plannotator/ui/components/ImageAnnotator';
import { getImageSrc } from '@plannotator/ui/components/ImageThumbnail';
import type { Annotation, ImageAttachment } from '@plannotator/ui/types';
import { InboxApiError, inboxApi } from '../api';
import { attachmentImageUrl, imageCommentAnnotation } from '../attachments';
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
 */
export function ImageAttachmentView({
  attachment,
  version,
  annotations,
  selectedId,
  readOnly,
  onSave,
  onError,
}: {
  attachment: InboxAttachmentState;
  version: 'current' | 'sent';
  annotations: readonly Annotation[];
  selectedId: string | null;
  readOnly: boolean;
  onSave: (annotation: Annotation) => Promise<boolean>;
  onError: (message: string) => void;
}) {
  const [fit, setFit] = useState<'fit' | 'actual'>('fit');
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [text, setText] = useState('');
  const [markup, setMarkup] = useState<ImageAttachment | null>(null);
  const [annotating, setAnnotating] = useState(false);
  const [saving, setSaving] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const src = attachmentImageUrl(attachment, version);

  useEffect(() => {
    setFit('fit');
    setNatural(null);
    setFailed(false);
  }, [attachment.id, version]);

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
      <div className="ib-imgstage" data-fit={fit} data-tall={tall ? 'true' : 'false'} data-src={stageSrc}>
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
