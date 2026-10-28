import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties } from 'react';
import { formatInboxVideoTime, inboxVideoMeta, readInboxVideoTime, type InboxAttachmentState } from '@plannotator/core/inbox-types';
import { ImageAnnotator } from '@plannotator/ui/components/ImageAnnotator';
import { getImageSrc } from '@plannotator/ui/components/ImageThumbnail';
import type { Annotation, ImageAttachment } from '@plannotator/ui/types';
import { InboxApiError } from '../api';
import { useInboxFileSource, type FileSuggestion } from '../fileSource';
import { compareVideoTimes, videoCommentAnnotation, videoFrameName, videoTimeOf } from '../attachments';
import { formatBytes, plural } from '../format';
import { Icon } from '../icons';
import { FileName } from './FileName';
import { Tip } from './Tip';
import { useConfigValue } from '@plannotator/ui/config';
import { isCommentSubmitKey } from '@plannotator/ui/utils/commentSubmitKey';
import { markupWords, noteOnto } from '../markup';
import { DRAWING_SCREEN, KeptMarkup, markupAddedToast, OverWindow, type Notice } from './Markup';

/** A fresh annotation id. */
function newId(): string {
  return typeof crypto.randomUUID === 'function' ? `ann-vid-${crypto.randomUUID()}` : `ann-vid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The frame a `<video>` shows now, as a JPEG at its own size, or null (no
 * frame decoded yet, no canvas, or a frame the browser will not hand over).
 * The film comes from the Inbox's own origin, so the canvas is never tainted.
 */
export function captureVideoFrame(video: HTMLVideoElement | null, quality = 0.85): Promise<Blob | null> {
  if (!video || !video.videoWidth || !video.videoHeight) return Promise.resolve(null);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) return Promise.resolve(null);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => {
      try {
        canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality);
      } catch {
        resolve(null);
      }
    });
  } catch {
    return Promise.resolve(null);
  }
}

export interface VideoAttachmentViewHandle {
  /** Seek to a comment's moment and pause there (a card or a time chip in the panel). */
  seekTo: (annotationId: string) => void;
}

/** A frame grabbed for the comment being written: the JPEG and a local URL to show it. */
interface Frame {
  blob: Blob;
  url: string;
}

/**
 * A video attachment in the pane (design record "inbox-video", approved
 * 2026-10-15): the native `<video controls>` fit to the stage, a rail under
 * it with one dot per comment (a click seeks there), and a comment row with
 * the moment, the paused frame, Mark up and Comment. Typing pauses the film
 * and pins the moment; a click on the moment seeks back to it. On Comment the
 * frame (or the person's marked-up copy, drawn with Plannotator's image
 * annotator) is kept through the markups route and rides the comment, so the
 * agent can Read the moment it cannot watch. A film the browser cannot play
 * shows the Download card. The film streams by HTTP Range from the
 * attachment's `video` route; nothing is read whole.
 *
 * On a phone the comments list under the rail, and the row opens from
 * "Comment at 1:42" at the foot.
 *
 * Mark up works as on an image (approval "inbox-markup-flow"): the drawing
 * screen's ✓ adds the marked-up frame to the reply at once, as a comment at
 * the pinned moment, with the window's toast and its Undo; the row keeps the
 * drawing (click: draw again; ×: take it out) beside "Note (optional)", whose
 * words go onto that same comment. Playing the film again lets the row go back
 * to following it. The row is the image's floating one-row card.
 */
export const VideoAttachmentView = forwardRef<VideoAttachmentViewHandle, {
  attachment: InboxAttachmentState;
  version: 'current' | 'sent';
  annotations: readonly Annotation[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  readOnly: boolean;
  onSave: (annotation: Annotation) => Promise<boolean>;
  onError: (message: string) => void;
  phone?: boolean;
  /** A still to show before it plays; absent: the film's first frame. */
  poster?: string;
  /**
   * A suggested comment (the tour's): the first pause fills the box with it and pins that moment and its
   * frame, as typing does; the person keeps it with one press, or writes over it.
   */
  suggestion?: FileSuggestion;
  /** Take a comment out of the reply (the drawing's × and the toast's Undo). */
  onRemove?: (id: string) => Promise<void> | void;
  /** The window's toast ("Markup added to your reply · Undo"). */
  onNotice?: Notice;
}>(function VideoAttachmentView({ attachment, version, annotations, selectedId, onSelect, readOnly, onSave, onError, phone, poster, suggestion, onRemove, onNotice }, ref) {
  const source = useInboxFileSource();
  const suggested = useRef(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [duration, setDuration] = useState<number | null>(attachment.duration_ms ? attachment.duration_ms / 1000 : null);
  const enterSavesComment = useConfigValue('enterSavesComment');
  const [current, setCurrent] = useState(0);
  const [ratio, setRatio] = useState(attachment.width && attachment.height ? attachment.width / attachment.height : 16 / 9);
  const [failed, setFailed] = useState(false);
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState('');
  const [pinned, setPinned] = useState<number | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [markup, setMarkup] = useState<ImageAttachment | null>(null);
  // The drawing the ✓ just added to the reply: its comment, for a note, a redraw or ×.
  const [kept, setKept] = useState<{ id: string; image: ImageAttachment; time: number } | null>(null);
  // One drawing per opening of the drawing screen: set as it opens, taken by the first ✓ or Enter. ui calls
  // onAccept once per press, each after its own encode, so a later press (even one landing after the first
  // drawing is in the reply) adds nothing.
  const acceptable = useRef(false);
  // The kept drawing's comment as it reads now; gone once removed (the panel, Undo) or sent, and the row lets it go.
  const keptNow = kept ? annotations.find((a) => a.id === kept.id) ?? null : null;
  useEffect(() => {
    if (kept && !keptNow) setKept(null);
  }, [kept, keptNow]);
  const [annotating, setAnnotating] = useState(false);
  useEffect(() => {
    if (annotating) acceptable.current = true;
  }, [annotating]);
  const [saving, setSaving] = useState(false);
  /** A phone opens the row from "Comment at 1:42". */
  const [composing, setComposing] = useState(false);
  // The `#t` fragment asks for the first frame, a free poster.
  const src = `${source.videoUrl(attachment, version)}#t=0.001`;

  // A frame's local URL is let go once it is replaced or the view goes.
  const frameRef = useRef<Frame | null>(null);
  frameRef.current = frame;
  useEffect(() => () => {
    if (frameRef.current) URL.revokeObjectURL(frameRef.current.url);
  }, []);
  const replaceFrame = useCallback((next: Frame | null) => {
    setFrame((previous) => {
      if (previous && previous !== next) URL.revokeObjectURL(previous.url);
      return next;
    });
  }, []);

  const sorted = useMemo(() => [...annotations].filter((a) => readInboxVideoTime(a) !== null).sort(compareVideoTimes), [annotations]);
  const span = duration && Number.isFinite(duration) && duration > 0 ? duration : null;
  const at = (time: number) => `${Math.min(100, Math.max(0, (time / span!) * 100))}%`;

  const seek = useCallback((time: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    try {
      video.currentTime = time;
    } catch {
      // Not seekable yet: the metadata is still loading.
    }
    setCurrent(time);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      seekTo: (id) => {
        const time = readInboxVideoTime(annotations.find((a) => a.id === id));
        if (time !== null) seek(time);
      },
    }),
    [annotations, seek],
  );

  // A comment selected elsewhere (the panel, the chip's list) brings the film to its moment.
  const lastSelected = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedId || selectedId === lastSelected.current) return;
    lastSelected.current = selectedId;
    const time = readInboxVideoTime(annotations.find((a) => a.id === selectedId));
    if (time !== null) seek(time);
  }, [selectedId, annotations, seek]);

  /** Pause and pin the moment the comment is about, and grab its frame. */
  const pin = useCallback(async (): Promise<Frame | null> => {
    const video = videoRef.current;
    if (pinned !== null) return frameRef.current;
    video?.pause();
    const time = videoTimeOf(video?.currentTime ?? current);
    setPinned(time);
    const blob = await captureVideoFrame(video);
    const next = blob ? { blob, url: URL.createObjectURL(blob) } : null;
    replaceFrame(next);
    return next;
  }, [pinned, current, replaceFrame]);

  const reset = () => {
    setText('');
    setPinned(null);
    setMarkup(null);
    setKept(null);
    replaceFrame(null);
    setComposing(false);
  };

  const shownTime = pinned ?? current;
  const canSave = !saving && (text.trim() !== '' || markup !== null);

  /** Take the added drawing out of the reply (its × or the toast's Undo). */
  const removeKept = (id: string) => {
    setKept((now) => (now?.id === id ? null : now));
    onSelect(null);
    void onRemove?.(id);
  };

  /**
   * The ✓: the marked-up frame goes into the reply now, as a comment at the
   * pinned moment (a redraw replaces the picture of the one already added).
   * Words already typed go with it; with none, the row offers a note.
   */
  const addDrawing = async (image: ImageAttachment) => {
    const words = text.trim();
    // A redraw: the comment as it reads now, its frame replaced (and any words typed, as a note).
    const redraw = kept && keptNow ? keptNow : null;
    const time = redraw && kept ? kept.time : pinned ?? videoTimeOf(videoRef.current?.currentTime ?? current);
    const id = redraw?.id ?? newId();
    const ok = await onSave(
      redraw
        ? ({ ...redraw, text: noteOnto(redraw, words), images: [image] } as Annotation)
        : videoCommentAnnotation({ id, name: attachment.name, time, text: markupWords(words, true), frame: image }),
    );
    if (!ok) {
      // Not saved (the error shows): the drawing waits in the row for Comment, as before.
      setMarkup(image);
      return;
    }
    setMarkup(null);
    if (words) reset();
    else {
      setText('');
      setKept({ id, image, time });
    }
    onSelect(id);
    // A new comment says so, with Undo; a redraw only replaced the frame (Undo would take the whole comment).
    if (!redraw) onNotice?.(markupAddedToast(() => removeKept(id)));
  };

  const submit = async () => {
    if (!canSave) return;
    // A note: onto the drawing the ✓ added, the same comment at the same moment.
    if (kept && keptNow) {
      setSaving(true);
      // (A redraw whose save failed waits as `markup`: it goes with the note.)
      const ok = await onSave({ ...keptNow, text: noteOnto(keptNow, text), ...(markup ? { images: [markup] } : {}) } as Annotation);
      setSaving(false);
      if (ok) reset();
      return;
    }
    setSaving(true);
    const time = pinned ?? videoTimeOf(videoRef.current?.currentTime ?? current);
    let image: ImageAttachment | null = markup;
    if (!image && frame) {
      try {
        const kept = await source.keepMarkup(frame.blob);
        image = { path: kept.path, name: videoFrameName(attachment.name, time) };
      } catch (cause) {
        // The comment still goes; only the frame is missing.
        onError(cause instanceof InboxApiError ? `The frame was not kept: ${cause.message}` : 'The frame was not kept; the comment was saved without it.');
      }
    }
    const ok = await onSave(videoCommentAnnotation({ id: newId(), name: attachment.name, time, text: markupWords(text, markup !== null), frame: image }));
    setSaving(false);
    if (ok) reset();
  };

  const openMarkup = async () => {
    const grabbed = frame ?? (await pin());
    if (grabbed) setAnnotating(true);
    else onError('This frame could not be grabbed to draw on.');
  };

  if (failed) {
    return (
      <div className="ib-docscroll" data-download-card="" data-video-unplayable="">
        <div className="ib-att-t ib-dlcard">
          <span className="ib-fi">
            <Icon name="film" size={18} />
          </span>
          <span className="ib-att-text">
            <FileName name={attachment.name} className="ib-nm" wrap />
            <span className="ib-kd">
              {formatBytes(attachment.current?.size ?? attachment.size)}. This video&rsquo;s format can&rsquo;t play here; download it to open it.
            </span>
          </span>
          {source.writes && (
            <a className="ib-btn ib-pri" href={source.downloadUrl(attachment, version)} download={attachment.name}>
              <Icon name="download" size={14} />
              Download
            </a>
          )}
        </div>
      </div>
    );
  }

  // The moment: following the film, or pinned while a comment is written (then a click goes back to it).
  const chip =
    pinned !== null ? (
      <Tip content={`The comment is pinned at ${formatInboxVideoTime(pinned)}; go back to it`}>
        <button
          type="button"
          className="ib-vtime"
          onClick={() => seek(pinned)}
          aria-label={`Pinned at ${formatInboxVideoTime(pinned)}, go back to it`}
          data-video-time=""
          data-pinned=""
        >
          {formatInboxVideoTime(pinned)}
        </button>
      </Tip>
    ) : (
      <span className="ib-vtime" data-video-time="">
        {formatInboxVideoTime(current)}
      </span>
    );

  const composer = !readOnly && (!phone || composing) && (
    <div className="ib-imgcompose ib-vidcompose" data-video-composer="" data-image-composer="">
      <div className="ib-ccard">
        {chip}
        {kept ? (
          <KeptMarkup image={kept.image} onRedraw={() => setAnnotating(true)} onRemove={() => removeKept(kept.id)} wide />
        ) : (
          (markup || frame) && (
            // `ib-markup` on a drawing: the pane's unsaved-comment question (unsavedComposer) knows a drawing not yet commented.
            <Tip content={markup ? 'Your marked-up frame rides this comment' : `The frame at ${formatInboxVideoTime(shownTime)} rides this comment`}>
              <span className={`ib-vframe${markup ? ' ib-markup' : ''}`} data-video-frame="">
                <img src={markup ? getImageSrc(markup.path) : frame!.url} alt="" />
                {markup && (
                  <span className="ib-vpen" aria-hidden="true">
                    <Icon name="pen" size={9} />
                  </span>
                )}
              </span>
            </Tip>
          )
        )}
        <textarea
          ref={textRef}
          className="ib-ta"
          rows={1}
          value={text}
          placeholder={kept ? 'Note (optional)' : `Comment at ${formatInboxVideoTime(shownTime)}…`}
          aria-label={kept ? `A note with your drawing at ${formatInboxVideoTime(kept.time)}` : `Comment on ${attachment.name} at ${formatInboxVideoTime(shownTime)}`}
          onChange={(event) => {
            const value = event.target.value;
            setText(value);
            // Typing pauses the film and pins the moment; clearing the words lets the moment follow the film again.
            if (value.trim() !== '' && pinned === null) void pin();
            else if (value.trim() === '' && !markup && !kept && !phone) {
              setPinned(null);
              replaceFrame(null);
            }
          }}
          onKeyDown={(event) => {
            if (isCommentSubmitKey(event, enterSavesComment)) {
              event.preventDefault();
              event.stopPropagation();
              void submit();
            }
          }}
        />
        <Tip content="Draw on this frame (pen, arrow, circle)">
          <button type="button" className="ib-btn ib-cbtn" onClick={() => void openMarkup()} data-markup-open="" aria-label={markup || kept ? 'Redraw' : 'Mark up'}>
            <Icon name="pen" size={15} />
            <span className="ib-cbtn-l" aria-hidden="true">
              {markup || kept ? 'Redraw' : 'Mark up'}
            </span>
          </button>
        </Tip>
        {phone && (
          <button type="button" className="ib-btn ib-ccancel" onClick={reset} data-video-cancel="">
            Cancel
          </button>
        )}
        <button type="button" className="ib-btn ib-pri ib-csave" onClick={() => void submit()} disabled={!canSave} data-video-comment-save="">
          {kept ? 'Add note' : 'Comment'}
        </button>
      </div>
    </div>
  );

  const meta = inboxVideoMeta(attachment);

  return (
    <div className={`ib-vidview${phone ? ' ib-vidphone' : ''}`} data-video-view={attachment.id}>
      <div className="ib-vidstage" data-claims-arrows={focused ? 'true' : undefined}>
        <div className="ib-vidbox" style={{ '--ib-ar': String(ratio) } as CSSProperties}>
          <video
            ref={videoRef}
            className="ib-video"
            src={src}
            controls
            preload="metadata"
            poster={poster}
            playsInline
            aria-label={attachment.name}
            data-video-player=""
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              if (Number.isFinite(video.duration) && video.duration > 0) setDuration(video.duration);
              if (video.videoWidth && video.videoHeight) setRatio(video.videoWidth / video.videoHeight);
            }}
            onDurationChange={(event) => {
              const d = event.currentTarget.duration;
              if (Number.isFinite(d) && d > 0) setDuration(d);
            }}
            onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
            onPlay={() => {
              // Playing on after a drawing went into the reply: the row follows the film again (the comment stays);
              // never while a redraw that failed to save waits in the row.
              if (kept && text.trim() === '' && !markup) reset();
            }}
            onPause={() => {
              // The first pause, with nothing written yet: the suggestion fills the box, and the moment pins.
              if (!suggestion || suggested.current || readOnly || text.trim() !== '' || phone) return;
              suggested.current = true;
              setText(suggestion.comment);
              void pin();
            }}
            onSeeked={(event) => setCurrent(event.currentTarget.currentTime)}
            onError={(event) => {
              const code = event.currentTarget.error?.code;
              // Aborted by the person (code 1) is not a format problem.
              if (code !== 1) setFailed(true);
            }}
          />
          {phone && (
            <div className="ib-vmeta" data-video-meta="">
              <span>{meta}</span>
              <span className="ib-sp" />
              <span>{plural(sorted.length, 'comment')}</span>
            </div>
          )}
          <div className="ib-vrail" role="group" aria-label="Comments on the timeline" data-video-rail="">
            {span !== null &&
              sorted.map((annotation) => {
                const time = readInboxVideoTime(annotation)!;
                return (
                  <Tip key={annotation.id} content={`${formatInboxVideoTime(time)}: ${annotation.text ?? ''}`}>
                    <button
                      type="button"
                      className={`ib-vdot${annotation.id === selectedId ? ' ib-on' : ''}`}
                      style={{ left: at(time) }}
                      onClick={() => {
                        seek(time);
                        onSelect(annotation.id);
                      }}
                      aria-label={`Go to the comment at ${formatInboxVideoTime(time)}`}
                      data-video-dot={annotation.id}
                    />
                  </Tip>
                );
              })}
            {span !== null && pinned !== null && <span className="ib-vdot ib-draft" style={{ left: at(pinned) }} aria-hidden="true" data-video-draft-dot="" />}
            {span !== null && <span className="ib-vplay" style={{ left: at(current) }} aria-hidden="true" />}
          </div>
        </div>
        {phone && sorted.length > 0 && (
          <div className="ib-vlist" data-video-list="">
            <div className="ib-vlbl">Comments</div>
            {sorted.map((annotation) => {
              const time = readInboxVideoTime(annotation)!;
              const image = annotation.images?.[0];
              return (
                <button
                  key={annotation.id}
                  type="button"
                  className={`ib-vcard${annotation.id === selectedId ? ' ib-on' : ''}`}
                  onClick={() => {
                    seek(time);
                    onSelect(annotation.id);
                  }}
                  data-video-card={annotation.id}
                >
                  <span className="ib-vtop">
                    <span className="ib-vtime">{formatInboxVideoTime(time)}</span>
                    {image && (
                      <span className="ib-vframe">
                        <img src={getImageSrc(image.path)} alt="" />
                        {/marked up$/.test(image.name) && (
                          <span className="ib-vpen" aria-hidden="true">
                            <Icon name="pen" size={9} />
                          </span>
                        )}
                      </span>
                    )}
                  </span>
                  <span className="ib-vtext">{annotation.text}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
      {composer}
      {phone && !readOnly && !composing && (
        <div className="ib-vbar" data-file-foot="">
          <button
            type="button"
            className="ib-btn ib-pri ib-vbig"
            onClick={() => {
              setComposing(true);
              if (suggestion && !suggested.current && text.trim() === '') {
                suggested.current = true;
                setText(suggestion.comment);
              }
              void pin();
              requestAnimationFrame(() => textRef.current?.focus());
            }}
            data-video-compose=""
          >
            Comment at {formatInboxVideoTime(current)}
          </button>
        </div>
      )}
      <OverWindow>
        <ImageAnnotator
          imageSrc={frame?.url ?? ''}
          isOpen={annotating && frame !== null}
          escapeCancels={DRAWING_SCREEN.escapeCancels}
          hint={DRAWING_SCREEN.hint}
          onClose={() => {
            setAnnotating(false);
            requestAnimationFrame(() => textRef.current?.focus());
          }}
          onAccept={async (blob, hasDrawings) => {
            // Nothing drawn: the plain frame still rides the comment.
            if (!hasDrawings || !acceptable.current) return;
            acceptable.current = false;
            try {
              const keptFile = await source.keepMarkup(blob);
              await addDrawing({ path: keptFile.path, name: `${videoFrameName(attachment.name, kept?.time ?? pinned ?? current)}, marked up` });
            } catch (cause) {
              onError(cause instanceof InboxApiError ? cause.message : 'The drawing was not kept.');
            }
          }}
        />
      </OverWindow>
    </div>
  );
});
