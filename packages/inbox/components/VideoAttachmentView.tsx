import { forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type RefObject, type SyntheticEvent } from 'react';
import { formatInboxVideoTime, inboxAttachmentKindLabel, inboxVideoMeta, readInboxAttachmentKind, readInboxVideoTime, type InboxAttachmentState } from '@plannotator/core/inbox-types';
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
import { FullScreenCommentBin, FullScreenComposer, FullScreenComposerContext } from './FullScreenComposer';
import { useConfigValue } from '@plannotator/ui/config';
import { isCommentSubmitKey } from '@plannotator/ui/utils/commentSubmitKey';
import { markupWords, noteOnto } from '../markup';
import { DRAWING_SCREEN, KeptMarkup, markupAddedToast, OverWindow, type Notice } from './Markup';
import { useRowDraft } from '../fileCommentDrafts';
import { markImageComposer } from '../pageMarks';
import { AudioScrub, useAudioPeaks } from './AudioPlayer';

function newId(): string {
  return typeof crypto.randomUUID === 'function' ? `ann-vid-${crypto.randomUUID()}` : `ann-vid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

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
  seekTo: (annotationId: string) => void;
}

interface Frame {
  blob: Blob;
  url: string;
}

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
  poster?: string;
  suggestion?: FileSuggestion;
  onRemove?: (id: string) => Promise<void> | void;
  onNotice?: Notice;
}>(function VideoAttachmentView({ attachment, version, annotations, selectedId, onSelect, readOnly, onSave, onError, phone, poster, suggestion, onRemove, onNotice }, ref) {
  const fullComposer = useContext(FullScreenComposerContext);
  const source = useInboxFileSource();
  const suggested = useRef(false);
  const audio = readInboxAttachmentKind(attachment.kind) === 'audio';
  const videoRef = useRef<HTMLMediaElement | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [duration, setDuration] = useState<number | null>(attachment.duration_ms ? attachment.duration_ms / 1000 : null);
  const enterSavesComment = useConfigValue('enterSavesComment');
  const [current, setCurrent] = useState(0);
  const [ratio, setRatio] = useState(attachment.width && attachment.height ? attachment.width / attachment.height : 16 / 9);
  const [failed, setFailed] = useState(false);
  const [focused, setFocused] = useState(false);
  const [playing, setPlaying] = useState(false);
  const waiting = useRowDraft(() => (readOnly || sentWords.current === text ? null : { kind: 'row', text, markup, time: pinned, frame: frameRef.current?.blob ?? null }));
  const [text, setText] = useState(waiting?.text ?? '');
  const [pinned, setPinned] = useState<number | null>(waiting?.time ?? null);
  const [frame, setFrame] = useState<Frame | null>(() => (waiting?.frame ? { blob: waiting.frame, url: URL.createObjectURL(waiting.frame) } : null));
  const [markup, setMarkup] = useState<ImageAttachment | null>(waiting?.markup ?? null);
  const sentWords = useRef<string | null>(null);
  const sendRow = async (annotation: Annotation) => {
    sentWords.current = text;
    const ok = await onSave(annotation);
    if (!ok) sentWords.current = null;
    return ok;
  };
  const [kept, setKept] = useState<{ id: string; image: ImageAttachment; time: number } | null>(null);
  const acceptable = useRef(false);
  const keptNow = kept ? annotations.find((a) => a.id === kept.id) ?? null : null;
  useEffect(() => {
    if (kept && !keptNow) setKept(null);
  }, [kept, keptNow]);
  const [annotating, setAnnotating] = useState(false);
  useEffect(() => {
    if (annotating) acceptable.current = true;
  }, [annotating]);
  const [saving, setSaving] = useState(false);
  const [composing, setComposing] = useState(waiting !== null);
  const mediaUrl = source.videoUrl(attachment, version);
  const src = audio ? mediaUrl : `${mediaUrl}#t=0.001`;
  const peaks = useAudioPeaks(audio ? mediaUrl : '', audio ? (attachment.current?.size ?? attachment.size) : Number.POSITIVE_INFINITY);

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

  const lastSelected = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedId || selectedId === lastSelected.current) return;
    lastSelected.current = selectedId;
    const time = readInboxVideoTime(annotations.find((a) => a.id === selectedId));
    if (time !== null) seek(time);
  }, [selectedId, annotations, seek]);

  useEffect(() => {
    if (waiting?.time != null) seek(waiting.time);
  }, []);

  const pin = useCallback(async (): Promise<Frame | null> => {
    const video = videoRef.current;
    if (pinned !== null) return frameRef.current;
    video?.pause();
    const time = videoTimeOf(video?.currentTime ?? current);
    setPinned(time);
    const blob = audio ? null : await captureVideoFrame(video as HTMLVideoElement | null);
    const next = blob ? { blob, url: URL.createObjectURL(blob) } : null;
    replaceFrame(next);
    return next;
  }, [pinned, current, replaceFrame, audio]);

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

  const removeKept = (id: string) => {
    setKept((now) => (now?.id === id ? null : now));
    onSelect(null);
    void onRemove?.(id);
  };

  const addDrawing = async (image: ImageAttachment) => {
    const words = text.trim();
    const redraw = kept && keptNow ? keptNow : null;
    const time = redraw && kept ? kept.time : pinned ?? videoTimeOf(videoRef.current?.currentTime ?? current);
    const id = redraw?.id ?? newId();
    const ok = await sendRow(
      redraw
        ? ({ ...redraw, text: noteOnto(redraw, words), images: [image] } as Annotation)
        : videoCommentAnnotation({ id, name: attachment.name, time, text: markupWords(words, true), frame: image }),
    );
    if (!ok) {
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
    if (!redraw) onNotice?.(markupAddedToast(() => removeKept(id)));
  };

  const submit = async () => {
    if (!canSave) return;
    if (kept && keptNow) {
      setSaving(true);
      const ok = await sendRow({ ...keptNow, text: noteOnto(keptNow, text), ...(markup ? { images: [markup] } : {}) } as Annotation);
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
        onError(cause instanceof InboxApiError ? `The frame was not kept: ${cause.message}` : 'The frame was not kept; the comment was saved without it.');
      }
    }
    const ok = await sendRow(videoCommentAnnotation({ id: newId(), name: attachment.name, time, text: markupWords(text, markup !== null), frame: image }));
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
            <Icon name={audio ? 'music' : 'film'} size={18} />
          </span>
          <span className="ib-att-text">
            <FileName name={attachment.name} className="ib-nm" wrap />
            <span className="ib-kd">
              {formatBytes(attachment.current?.size ?? attachment.size)}. This {audio ? 'recording' : 'video'}&rsquo;s format can&rsquo;t play here; download it to open it.
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

  const commentCard = (
    <div className="ib-ccard">
      {chip}
      {kept ? (
        <KeptMarkup image={kept.image} onRedraw={() => setAnnotating(true)} onRemove={() => removeKept(kept.id)} wide />
      ) : (
        (markup || frame) && (
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
          if (value.trim() !== '' && pinned === null) void pin();
          else if (value.trim() === '' && !markup && !kept && (!phone || fullComposer)) {
            setPinned(null);
            replaceFrame(null);
          }
        }}
        onFocus={() => {
          if (phone && fullComposer && pinned === null && !kept && !markup) void pin();
        }}
        onKeyDown={(event) => {
          if (isCommentSubmitKey(event, enterSavesComment)) {
            event.preventDefault();
            event.stopPropagation();
            void submit();
          }
        }}
      />
      {!audio && (
        <Tip content="Draw on this frame (pen, arrow, circle)">
          <button type="button" className="ib-btn ib-cbtn" onClick={() => void openMarkup()} data-markup-open="" aria-label={markup || kept ? 'Redraw' : 'Mark up'}>
            <Icon name="pen" size={15} />
            <span className="ib-cbtn-l" aria-hidden="true">
              {markup || kept ? 'Redraw' : 'Mark up'}
            </span>
          </button>
        </Tip>
      )}
      {phone && !fullComposer && (
        <button type="button" className="ib-btn ib-ccancel" onClick={reset} data-video-cancel="">
          Cancel
        </button>
      )}
      <FullScreenCommentBin />
      <button type="button" className="ib-btn ib-pri ib-csave" onClick={() => void submit()} disabled={!canSave} data-video-comment-save="">
        {kept ? 'Add note' : 'Comment'}
      </button>
    </div>
  );
  const composer = fullComposer ? (
    <FullScreenComposer
      value={fullComposer}
      noun={audio ? 'recording' : 'video'}
      comment={
        readOnly ? null : (
          <div className="ib-fcomp-comment" data-video-composer="" data-image-composer="">
            {commentCard}
          </div>
        )
      }
    />
  ) : (
    !readOnly &&
    (!phone || composing) && (
      <div ref={markImageComposer} className="ib-imgcompose ib-vidcompose" data-video-composer="" data-image-composer="">
        {commentCard}
      </div>
    )
  );

  const meta = inboxVideoMeta(attachment) || (audio && span !== null ? formatInboxVideoTime(span) : '');

  const mediaProps = {
    src,
    preload: 'metadata',
    'aria-label': attachment.name,
    'data-video-player': '',
    onLoadedMetadata: (event: SyntheticEvent<HTMLMediaElement>) => {
      const media = event.currentTarget;
      if (Number.isFinite(media.duration) && media.duration > 0) setDuration(media.duration);
      if (media instanceof HTMLVideoElement && media.videoWidth && media.videoHeight) setRatio(media.videoWidth / media.videoHeight);
    },
    onDurationChange: (event: SyntheticEvent<HTMLMediaElement>) => {
      const d = event.currentTarget.duration;
      if (Number.isFinite(d) && d > 0) setDuration(d);
    },
    onTimeUpdate: (event: SyntheticEvent<HTMLMediaElement>) => setCurrent(event.currentTarget.currentTime),
    onPlay: () => {
      setPlaying(true);
      if (kept && text.trim() === '' && !markup) reset();
    },
    onPause: () => {
      setPlaying(false);
      if (!suggestion || suggested.current || readOnly || text.trim() !== '' || (phone && !fullComposer)) return;
      suggested.current = true;
      setText(suggestion.comment);
      void pin();
    },
    onEnded: () => setPlaying(false),
    onSeeked: (event: SyntheticEvent<HTMLMediaElement>) => setCurrent(event.currentTarget.currentTime),
    onError: (event: SyntheticEvent<HTMLMediaElement>) => {
      const code = event.currentTarget.error?.code;
      if (code !== 1) setFailed(true);
    },
  };

  const phoneMeta = phone && (
    <div className="ib-vmeta" data-video-meta="">
      <span>{meta}</span>
      <span className="ib-sp" />
      <span>{plural(sorted.length, 'comment')}</span>
    </div>
  );

  const rail = (
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
      {span !== null && !audio && <span className="ib-vplay" style={{ left: at(current) }} aria-hidden="true" />}
    </div>
  );

  const togglePlay = () => {
    const media = videoRef.current;
    if (!media) return;
    if (media.paused) void media.play().catch(() => {});
    else media.pause();
  };

  const scrubTo = (time: number) => {
    const media = videoRef.current;
    if (!media) return;
    try {
      media.currentTime = time;
    } catch {
    }
    setCurrent(time);
  };

  const stageBody = audio ? (
    <div className="ib-audbox" data-audio-player="">
      <audio ref={videoRef as RefObject<HTMLAudioElement>} {...mediaProps} />
      <div className="ib-audtop">
        <span className="ib-audic" aria-hidden="true">
          <Icon name="music" size={16} />
        </span>
        <span className="ib-audnm">
          <FileName name={attachment.name} />
        </span>
        <span className="ib-audmeta">{[inboxAttachmentKindLabel(attachment.kind, attachment.name, attachment.media_type), phone ? '' : meta].filter(Boolean).join(' · ')}</span>
      </div>
      <div className="ib-audrow">
        <button type="button" className="ib-audplay" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'} data-audio-play={playing ? 'playing' : 'paused'}>
          <Icon name={playing ? 'pause' : 'play'} size={18} />
        </button>
        <div className="ib-audtrack">
          <AudioScrub name={attachment.name} peaks={peaks} current={current} span={span} onSeek={scrubTo} onFocusChange={setFocused}>
            {span !== null && <span className="ib-vplay" style={{ left: at(current) }} aria-hidden="true" />}
          </AudioScrub>
          {rail}
        </div>
        <span className="ib-audtime" data-video-time-now="">
          {formatInboxVideoTime(current)}
          {span !== null && <span className="ib-mut"> / {formatInboxVideoTime(span)}</span>}
        </span>
      </div>
      {phoneMeta}
    </div>
  ) : (
    <div className="ib-vidbox" style={{ '--ib-ar': String(ratio) } as CSSProperties}>
      <video
        ref={videoRef as RefObject<HTMLVideoElement>}
        className="ib-video"
        {...mediaProps}
        controls
        poster={poster}
        playsInline
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
      {phoneMeta}
      {rail}
    </div>
  );

  return (
    <div className={`ib-vidview${phone ? ' ib-vidphone' : ''}${audio ? ' ib-audview' : ''}`} data-video-view={attachment.id} data-audio-view={audio ? attachment.id : undefined}>
      <div className={`ib-vidstage${audio ? ' ib-audstage' : ''}`} data-claims-arrows={focused ? 'true' : undefined}>
        {stageBody}
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
      {phone && !readOnly && !composing && !fullComposer && (
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
