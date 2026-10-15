import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties } from 'react';
import { formatInboxVideoTime, inboxVideoMeta, readInboxVideoTime, type InboxAttachmentState } from '@plannotator/core/inbox-types';
import { ImageAnnotator } from '@plannotator/ui/components/ImageAnnotator';
import { getImageSrc } from '@plannotator/ui/components/ImageThumbnail';
import type { Annotation, ImageAttachment } from '@plannotator/ui/types';
import { InboxApiError, inboxApi } from '../api';
import { attachmentDownloadUrl, attachmentVideoUrl, compareVideoTimes, videoCommentAnnotation, videoFrameName, videoTimeOf } from '../attachments';
import { formatBytes, plural } from '../format';
import { Icon } from '../icons';
import { FileName } from './FileName';

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
 */
export const VideoAttachmentView = forwardRef<VideoAttachmentViewHandle, {
  attachment: InboxAttachmentState;
  version: 'current' | 'sent';
  annotations: readonly Annotation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  readOnly: boolean;
  onSave: (annotation: Annotation) => Promise<boolean>;
  onError: (message: string) => void;
  phone?: boolean;
}>(function VideoAttachmentView({ attachment, version, annotations, selectedId, onSelect, readOnly, onSave, onError, phone }, ref) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [duration, setDuration] = useState<number | null>(attachment.duration_ms ? attachment.duration_ms / 1000 : null);
  const [current, setCurrent] = useState(0);
  const [ratio, setRatio] = useState(attachment.width && attachment.height ? attachment.width / attachment.height : 16 / 9);
  const [failed, setFailed] = useState(false);
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState('');
  const [pinned, setPinned] = useState<number | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [markup, setMarkup] = useState<ImageAttachment | null>(null);
  const [annotating, setAnnotating] = useState(false);
  const [saving, setSaving] = useState(false);
  /** A phone opens the row from "Comment at 1:42". */
  const [composing, setComposing] = useState(false);
  // The `#t` fragment asks for the first frame, a free poster.
  const src = `${attachmentVideoUrl(attachment, version)}#t=0.001`;

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
    replaceFrame(null);
    setComposing(false);
  };

  const shownTime = pinned ?? current;
  const canSave = !saving && text.trim() !== '';

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    const time = pinned ?? videoTimeOf(videoRef.current?.currentTime ?? current);
    let image: ImageAttachment | null = markup;
    if (!image && frame) {
      try {
        const kept = await inboxApi.uploadMarkup(frame.blob);
        image = { path: kept.path, name: videoFrameName(attachment.name, time) };
      } catch (cause) {
        // The comment still goes; only the frame is missing.
        onError(cause instanceof InboxApiError ? `The frame was not kept: ${cause.message}` : 'The frame was not kept; the comment was saved without it.');
      }
    }
    const ok = await onSave(videoCommentAnnotation({ id: newId(), name: attachment.name, time, text: text.trim(), frame: image }));
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
          <a className="ib-btn ib-pri" href={attachmentDownloadUrl(attachment, version)} download={attachment.name}>
            <Icon name="download" size={14} />
            Download
          </a>
        </div>
      </div>
    );
  }

  // The moment: following the film, or pinned while a comment is written (then a click goes back to it).
  const chip =
    pinned !== null ? (
      <button
        type="button"
        className="ib-vtime"
        onClick={() => seek(pinned)}
        title={`The comment is pinned at ${formatInboxVideoTime(pinned)}; go back to it`}
        aria-label={`Pinned at ${formatInboxVideoTime(pinned)}, go back to it`}
        data-video-time=""
        data-pinned=""
      >
        {formatInboxVideoTime(pinned)}
      </button>
    ) : (
      <span className="ib-vtime" data-video-time="">
        {formatInboxVideoTime(current)}
      </span>
    );

  const composer = !readOnly && (!phone || composing) && (
    <div className="ib-imgcompose ib-vidcompose" data-video-composer="" data-image-composer="">
      {chip}
      {(markup || frame) && (
        // `ib-markup` on a drawing: the pane's unsaved-comment question (unsavedComposer) knows a drawing not yet commented.
        <span className={`ib-vframe${markup ? ' ib-markup' : ''}`} title={markup ? 'Your marked-up frame rides this comment' : `The frame at ${formatInboxVideoTime(shownTime)} rides this comment`} data-video-frame="">
          <img src={markup ? getImageSrc(markup.path) : frame!.url} alt="" />
          {markup && (
            <span className="ib-vpen" aria-hidden="true">
              <Icon name="pen" size={9} />
            </span>
          )}
        </span>
      )}
      <textarea
        ref={textRef}
        className="ib-ta"
        rows={1}
        value={text}
        placeholder={`Comment at ${formatInboxVideoTime(shownTime)}…`}
        aria-label={`Comment on ${attachment.name} at ${formatInboxVideoTime(shownTime)}`}
        onChange={(event) => {
          const value = event.target.value;
          setText(value);
          // Typing pauses the film and pins the moment; clearing the words lets the moment follow the film again.
          if (value.trim() !== '' && pinned === null) void pin();
          else if (value.trim() === '' && !markup && !phone) {
            setPinned(null);
            replaceFrame(null);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            void submit();
          }
        }}
      />
      <button type="button" className="ib-btn" onClick={() => void openMarkup()} title="Draw on this frame (pen, arrow, circle)" data-markup-open="">
        <Icon name="pen" size={14} />
        {markup ? 'Redraw' : 'Mark up'}
      </button>
      {phone && (
        <button type="button" className="ib-btn" onClick={reset} data-video-cancel="">
          Cancel
        </button>
      )}
      <button type="button" className="ib-btn ib-pri" onClick={() => void submit()} disabled={!canSave} data-video-comment-save="">
        Comment
      </button>
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
                  <button
                    key={annotation.id}
                    type="button"
                    className={`ib-vdot${annotation.id === selectedId ? ' ib-on' : ''}`}
                    style={{ left: at(time) }}
                    onClick={() => {
                      seek(time);
                      onSelect(annotation.id);
                    }}
                    title={`${formatInboxVideoTime(time)}: ${annotation.text ?? ''}`}
                    aria-label={`Go to the comment at ${formatInboxVideoTime(time)}`}
                    data-video-dot={annotation.id}
                  />
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
        <div className="ib-vbar">
          <button
            type="button"
            className="ib-btn ib-pri ib-vbig"
            onClick={() => {
              setComposing(true);
              void pin();
              requestAnimationFrame(() => textRef.current?.focus());
            }}
            data-video-compose=""
          >
            Comment at {formatInboxVideoTime(current)}
          </button>
        </div>
      )}
      <ImageAnnotator
        imageSrc={frame?.url ?? ''}
        isOpen={annotating && frame !== null}
        onClose={() => {
          setAnnotating(false);
          requestAnimationFrame(() => textRef.current?.focus());
        }}
        onAccept={async (blob, hasDrawings) => {
          // Nothing drawn: the plain frame still rides the comment.
          if (!hasDrawings) return;
          try {
            const kept = await inboxApi.uploadMarkup(blob);
            setMarkup({ path: kept.path, name: `${videoFrameName(attachment.name, pinned ?? current)}, marked up` });
          } catch (cause) {
            onError(cause instanceof InboxApiError ? cause.message : 'The drawing was not kept.');
          }
        }}
      />
    </div>
  );
});
