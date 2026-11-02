import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent } from 'react';
import { inboxAttachmentKindLabel, readInboxAttachmentKind, type InboxUpload } from '@plannotator/core/inbox-types';
import { InboxApiError, uploadFile } from '../api';
import { formatBytes } from '../format';
import { Icon, type IconName } from '../icons';
import { FileName } from '../components/FileName';
import { Tip } from '../components/Tip';
import { isPhone } from '../phone';
import { chosenFiles, clipboardHasText, pastedFiles, pastedImageOwnLink } from './paste';
import { PASTED_UNDO_MS, isLongPaste, mapAnchor, pastedPreview, pastedTextName, putTextBack } from './pastedText';

/**
 * Compose's files, and the reply box's: each one the person picked, dropped
 * or pasted (paste.ts), uploaded at once
 * (streamed, with progress, removable while it uploads: the request is
 * aborted), or refused in its own tile (the dotenv family, too large).
 * Uploaded files become ordinary attachments when the message is sent.
 */
export interface ComposeFile {
  /** Stable for React; the upload's id once it is in. */
  key: string;
  name: string;
  size: number;
  state: 'uploading' | 'done' | 'refused';
  progress: number;
  upload: InboxUpload | null;
  error: string | null;
  /** A local preview of an image picked in this tab (never for a reopened draft). */
  preview: string | null;
  /** A long paste attached as a file (pastedText.ts): the words it holds, so Put back can return them. */
  pasted?: PastedText | null;
}

/** A long paste the person can put back in the box. */
export interface PastedText {
  /** The exact text pasted. */
  text: string;
  /** The tile's name line: the first words (pastedPreview). */
  preview: string;
  /** When it was pasted (ms): the tile reads "Undo" for PASTED_UNDO_MS. */
  at: number;
}

/**
 * The words of the box the files belong to, so a long paste can become a tile
 * and be put back where it was pasted. `value` is the box's text on this
 * render; `set` changes it (the host's own change: the reply box saves its draft).
 */
export interface ComposeFilesText {
  value: string;
  set: (next: string) => void;
}

/** Where a long paste goes back: an offset into the box's text, and what goes before it (the thread-name chip's space). */
interface PasteAnchor {
  at: number;
  lead: string;
}

const fromUpload = (upload: InboxUpload): ComposeFile => ({
  key: upload.upload_id,
  name: upload.name,
  size: upload.size,
  state: 'done',
  progress: 1,
  upload,
  error: null,
  preview: null,
});

/** What a paste attached, as a screen reader hears it: "Attached notes.png", "Attached 2 files: a.png, b.png". */
export function attachedAnnouncement(names: readonly string[]): string {
  return names.length === 1 ? `Attached ${names[0]}` : `Attached ${names.length} files: ${names.join(', ')}`;
}

/**
 * The files of one compose session (or reply box), and its uploads.
 * `onPasted`: the names a paste attached, for the host's polite live region.
 * `text`: the box's words. With it, a paste of 32 KB or more becomes a pasted
 * text tile (pastedText.ts) that `putBack` (the tile's Undo and Put back) and
 * the browser's own undo, as the very next edit, return to the box.
 */
export function useComposeFiles(
  initial: readonly InboxUpload[],
  options: { onPasted?: (names: string[]) => void; machine?: string | null; text?: ComposeFilesText; onPutBack?: () => void } = {},
) {
  const [files, setFiles] = useState<ComposeFile[]>(() => initial.map(fromUpload));
  const aborts = useRef(new Map<string, AbortController>());
  /** Each local preview's object URL by its file's key, freed when the file goes. */
  const previews = useRef(new Map<string, string>());
  const filesRef = useRef<ComposeFile[]>(files);
  filesRef.current = files;
  const onPasted = useRef(options.onPasted);
  onPasted.current = options.onPasted;
  const onPutBack = useRef(options.onPutBack);
  onPutBack.current = options.onPutBack;
  // Linked machines: a reply to another machine's thread uploads its files to that machine.
  const machine = useRef(options.machine ?? null);
  machine.current = options.machine ?? null;
  const text = useRef(options.text);
  text.current = options.text;
  /** Each pasted text tile's place in the box's words, by its file's key. */
  const anchors = useRef(new Map<string, PasteAnchor>());
  /** The words the anchors refer to: every other change of the box's words carries them along (mapAnchor). */
  const anchoredIn = useRef(options.text?.value ?? '');
  if (options.text && options.text.value !== anchoredIn.current) {
    for (const anchor of anchors.current.values()) anchor.at = mapAnchor(anchoredIn.current, options.text.value, anchor.at);
    anchoredIn.current = options.text.value;
  }
  /** The browser's undo puts this tile back while it is the field's very next edit (the paste's own undo). */
  const undoArm = useRef<{ key: string; field: HTMLTextAreaElement } | null>(null);
  /** After a put back: the caret goes after the words once the box shows them. */
  const caretAfter = useRef<{ field: HTMLTextAreaElement; caret: number } | null>(null);
  const release = (key: string) => {
    aborts.current.get(key)?.abort();
    aborts.current.delete(key);
    const url = previews.current.get(key);
    if (url) URL.revokeObjectURL(url);
    previews.current.delete(key);
    anchors.current.delete(key);
    if (undoArm.current?.key === key) undoArm.current = null;
  };
  const patch = (key: string, change: Partial<ComposeFile>) => setFiles((current) => current.map((file) => (file.key === key ? { ...file, ...change } : file)));

  const addOne = (file: File, pasted: PastedText | null = null): string => {
    const key = `local-${crypto.randomUUID()}`;
    const preview = file.type.startsWith('image/') && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null;
    if (preview) previews.current.set(key, preview);
    setFiles((current) => [...current, { key, name: file.name, size: file.size, state: 'uploading', progress: 0, upload: null, error: null, preview, ...(pasted ? { pasted } : {}) }]);
    const controller = new AbortController();
    aborts.current.set(key, controller);
    uploadFile(file, { machine: machine.current, signal: controller.signal, onProgress: (loaded, total) => patch(key, { progress: total > 0 ? loaded / total : 0 }) })
      .then((upload) => patch(key, { state: 'done', progress: 1, upload }))
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        patch(key, { state: 'refused', error: cause instanceof InboxApiError ? cause.message : 'Not attached: the upload failed.' });
      })
      .finally(() => aborts.current.delete(key));
    return key;
  };

  const add = useCallback((list: Iterable<File>) => {
    for (const file of list) addOne(file);
  }, []);

  const remove = useCallback((key: string) => {
    release(key);
    setFiles((current) => current.filter((file) => file.key !== key));
  }, []);

  /** Forget these files (a Send carried them): the ones added since stay. */
  const forget = useCallback((keys: ReadonlySet<string>) => {
    for (const key of keys) release(key);
    setFiles((current) => current.filter((file) => !keys.has(file.key)));
  }, []);

  /** Forget every file (the reply box closed, or the thread changed): uploads in flight are aborted. */
  const reset = useCallback(() => {
    for (const key of [...aborts.current.keys(), ...previews.current.keys(), ...anchors.current.keys()]) release(key);
    undoArm.current = null;
    setFiles((current) => (current.length === 0 ? current : []));
  }, []);

  /** The files as they are now (for a Send that awaited: what was added meanwhile). */
  const current = useCallback(() => filesRef.current, []);

  // The names already attached, for a pasted file's name (`-2` when one is taken).
  const namesRef = useRef<string[]>([]);
  namesRef.current = files.map((file) => file.name);

  /**
   * A paste (paste.ts): the files the clipboard carries attach. Read from
   * `event.clipboardData` synchronously, never the async clipboard. The
   * browser's own paste is prevented only when the clipboard holds files and
   * no text; text alone, or text beside files, goes through natively. True
   * when it took files.
   */
  /**
   * A long text attached as a pasted text tile, to go back at `at` in the box's
   * words (`lead` before it). `field`: the box it was pasted into, whose next
   * edit may be the browser's undo of it.
   */
  const takeText = useCallback((words: string, at: number, options: { field?: HTMLTextAreaElement | null; lead?: string } = {}) => {
    const name = pastedTextName(new Date(), namesRef.current);
    namesRef.current = [...namesRef.current, name];
    const key = addOne(new File([words], name, { type: 'text/plain' }), { text: words, preview: pastedPreview(words), at: Date.now() });
    anchors.current.set(key, { at, lead: options.lead ?? '' });
    undoArm.current = options.field ? { key, field: options.field } : null;
    onPasted.current?.([name]);
    return key;
  }, []);

  const paste = useCallback(
    (event: ReactClipboardEvent<HTMLElement>): boolean => {
      if (event.defaultPrevented) return false;
      const data = event.clipboardData;
      const phone = isPhone();
      const list = pastedFiles(data, namesRef.current, new Date(), { phone });
      if (list.length === 0) return pasteLongText(event);
      // Text the person meant still pastes natively; on a phone an image's own link (paste.ts) is not inserted.
      if (!clipboardHasText(data) || pastedImageOwnLink(data, phone)) event.preventDefault();
      namesRef.current = [...namesRef.current, ...list.map((file) => file.name)];
      add(list);
      onPasted.current?.(list.map((file) => file.name));
      return true;
    },
    [add],
  );

  /**
   * A paste of text alone into the box's field, 32 KB or more: the browser's
   * paste is prevented and the text becomes a tile, anchored where it would
   * have landed. A selection it would have replaced goes, as a paste takes it.
   * Shorter text, or a paste into anything but the box's field (the thread
   * name, a read-only box while a Send is on its way), is left to the browser.
   */
  const pasteLongText = (event: ReactClipboardEvent<HTMLElement>): boolean => {
    const host = text.current;
    const field = event.target;
    if (!host || !(field instanceof HTMLTextAreaElement) || field.readOnly || field.disabled) return false;
    let words = '';
    try {
      words = event.clipboardData?.getData('text/plain') ?? '';
    } catch {
      return false;
    }
    if (!isLongPaste(words)) return false;
    event.preventDefault();
    // The field shows the words the anchor is in (full screen's card shows the kept draft while the box is closed).
    const shown = field.value;
    const start = Math.min(field.selectionStart ?? shown.length, shown.length);
    const end = Math.max(start, Math.min(field.selectionEnd ?? start, shown.length));
    let words0 = shown;
    if (end > start) {
      words0 = shown.slice(0, start) + shown.slice(end);
      for (const anchor of anchors.current.values()) anchor.at = mapAnchor(shown, words0, anchor.at);
    }
    anchoredIn.current = words0;
    takeText(words, start, { field });
    if (end > start) host.set(words0);
    return true;
  };

  /**
   * Put a pasted text tile's words back in the box (its Undo, Put back in box,
   * or the browser's undo): exactly where they were pasted, the words around
   * them untouched, the caret after them in `field`. The tile goes. False when
   * `key` is not a pasted text tile.
   */
  const putBack = useCallback((key: string, field: HTMLTextAreaElement | null = null): boolean => {
    const host = text.current;
    const file = filesRef.current.find((f) => f.key === key);
    // A read-only box (a Send on its way carries the words in it) takes nothing back.
    if (!host || !file?.pasted || field?.readOnly) return false;
    const value = host.value;
    if (anchoredIn.current !== value) {
      for (const anchor of anchors.current.values()) anchor.at = mapAnchor(anchoredIn.current, value, anchor.at);
    }
    const own = anchors.current.get(key) ?? { at: value.length, lead: '' };
    const inserted = own.lead + file.pasted.text;
    const back = putTextBack(value, own.at, inserted);
    const place = back.caret - inserted.length;
    // The other tiles' places: after this one's move by its length. One pasted later at the same place came after it.
    const order = filesRef.current.map((f) => f.key);
    for (const [other, anchor] of anchors.current) {
      if (other === key) continue;
      if (anchor.at > place || (anchor.at === place && order.indexOf(other) > order.indexOf(key))) anchor.at += inserted.length;
    }
    anchoredIn.current = back.value;
    release(key);
    setFiles((current) => current.filter((f) => f.key !== key));
    host.set(back.value);
    const target = field ?? undoArm.current?.field ?? null;
    if (target) caretAfter.current = { field: target, caret: back.caret };
    onPutBack.current?.();
    return true;
  }, []);

  // The caret after the words put back, once the field shows them (a controlled field puts it at its end).
  useLayoutEffect(() => {
    const pending = caretAfter.current;
    if (!pending || pending.field.value.length < pending.caret) return;
    caretAfter.current = null;
    if (!pending.field.isConnected) return;
    pending.field.focus();
    pending.field.setSelectionRange(pending.caret, pending.caret);
  });

  /**
   * The browser's own undo (⌘Z / Ctrl+Z, Edit → Undo: `historyUndo`), as the
   * field's very next edit after a long paste, puts that paste back instead.
   * Any other edit of that field first stands it down; edits elsewhere do not.
   * Read as the edit it is, never as a key, so no shortcut is added. A
   * browser that cannot cancel it is left alone.
   */
  useEffect(() => {
    const onBeforeInput = (event: Event) => {
      const arm = undoArm.current;
      if (!arm || event.target !== arm.field) return;
      undoArm.current = null;
      if ((event as InputEvent).inputType !== 'historyUndo' || !event.cancelable) return;
      event.preventDefault();
      putBack(arm.key, arm.field);
    };
    // An edit with no `beforeinput` before it (an older engine) stands it down too.
    const onInput = (event: Event) => {
      if (undoArm.current && event.target === undoArm.current.field) undoArm.current = null;
    };
    document.addEventListener('beforeinput', onBeforeInput, true);
    document.addEventListener('input', onInput, true);
    return () => {
      document.removeEventListener('beforeinput', onBeforeInput, true);
      document.removeEventListener('input', onInput, true);
    };
  }, [putBack]);

  /**
   * Files chosen with the attach button (a phone's: iOS offers no Paste for a
   * picture in a plain text field), named and announced as a paste is.
   */
  const attach = useCallback(
    (list: Iterable<File>) => {
      const named = chosenFiles(list, namesRef.current);
      if (named.length === 0) return;
      namesRef.current = [...namesRef.current, ...named.map((file) => file.name)];
      add(named);
      onPasted.current?.(named.map((file) => file.name));
    },
    [add],
  );

  useEffect(
    () => () => {
      for (const controller of aborts.current.values()) controller.abort();
      for (const url of previews.current.values()) URL.revokeObjectURL(url);
      previews.current.clear();
    },
    [],
  );

  const uploaded = files.filter((file) => file.state === 'done' && file.upload).map((file) => file.upload!);
  const uploading = files.some((file) => file.state === 'uploading');
  return { files, add, attach, remove, forget, reset, current, paste, takeText, putBack, uploaded, uploading };
}

/** A phone's picker offers the photo library and Files (iOS gives no Paste for a picture in a text field). */
const PHONE_ACCEPT = 'image/*,*/*';

/**
 * The paperclip: a label over a hidden `<input type="file" multiple>`, named
 * "Attach files" with a `Tip`. Any file type; on a phone the picker offers the
 * photo library too. `onFiles` gets what was chosen (the input is emptied, so
 * the same file can be picked again). New message's foot and the reply box's
 * toolbar both use it.
 */
export function AttachFilesButton({
  className,
  iconSize,
  phone = false,
  onFiles,
  inputData,
}: {
  className: string;
  iconSize: number;
  phone?: boolean;
  onFiles: (files: FileList) => void;
  /** A `data-*` attribute for the input, for tests and the page's own lookups. */
  inputData?: string;
}) {
  return (
    <Tip content="Attach files">
      <label className={className} aria-label="Attach files">
        <Icon name="clip" size={iconSize} />
        <input
          type="file"
          multiple
          className="ib-sr"
          accept={phone ? PHONE_ACCEPT : undefined}
          {...(inputData ? { [inputData]: '' } : {})}
          onChange={(event) => {
            if (event.target.files && event.target.files.length > 0) onFiles(event.target.files);
            event.target.value = '';
          }}
        />
      </label>
    </Tip>
  );
}

/** A drag that carries files from the system (not text, a link, or a card being moved). */
export function dragHasFiles(event: ReactDragEvent): boolean {
  return [...event.dataTransfer.types].includes('Files');
}

/**
 * A drag that started on the page itself (an image in a message dragged a
 * little): `dragstart` fires only for those, never for files from the system,
 * and `dragend` ends it. Some browsers give such a drag a `Files` type, so the
 * drop targets below ignore it. One pair of document listeners for every
 * target on the page.
 */
let pageDrag = false;
let pageDragWatchers = 0;
const onPageDragStart = () => {
  pageDrag = true;
};
const onPageDragEnd = () => {
  pageDrag = false;
};
function watchPageDrags(): () => void {
  if (pageDragWatchers++ === 0) {
    document.addEventListener('dragstart', onPageDragStart, true);
    document.addEventListener('dragend', onPageDragEnd, true);
  }
  return () => {
    if (--pageDragWatchers > 0) return;
    document.removeEventListener('dragstart', onPageDragStart, true);
    document.removeEventListener('dragend', onPageDragEnd, true);
    pageDrag = false;
  };
}

/**
 * A drop target for files: `over` while files are dragged over it, `onFiles`
 * on a drop. Drags that carry no files (text, a link, a Board card) pass
 * through untouched, and so does a drag that started on the page itself. A
 * drag or drop a target inside already took (`defaultPrevented`: the reply box
 * inside the thread) is left to it, and `over` goes off, so only the innermost
 * target shows.
 */
export function useFileDrop(onFiles: (files: FileList) => void, enabled = true) {
  const [over, setOver] = useState(false);
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;
  useEffect(() => {
    if (!enabled) setOver(false);
  }, [enabled]);
  useEffect(() => watchPageDrags(), []);
  const onDragOver = useCallback(
    (event: ReactDragEvent) => {
      if (!enabled || pageDrag || !dragHasFiles(event)) return;
      if (event.defaultPrevented) {
        setOver(false);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setOver(true);
    },
    [enabled],
  );
  const onDragLeave = useCallback((event: ReactDragEvent) => {
    // Still inside (onto a child); leaving the window has no related target.
    const to = event.relatedTarget;
    if (to instanceof Node && event.currentTarget.contains(to)) return;
    setOver(false);
  }, []);
  const onDrop = useCallback(
    (event: ReactDragEvent) => {
      setOver(false);
      if (!enabled || pageDrag || event.defaultPrevented || event.dataTransfer.files.length === 0) return;
      event.preventDefault();
      onFilesRef.current(event.dataTransfer.files);
    },
    [enabled],
  );
  return { over, handlers: { onDragOver, onDragEnter: onDragOver, onDragLeave, onDrop } };
}

function iconFor(upload: Pick<InboxUpload, 'kind'> | null): IconName {
  switch (upload ? readInboxAttachmentKind(upload.kind) : null) {
    case 'image':
      return 'photo';
    case 'html':
    case 'code':
      return 'code';
    case 'file':
      return 'cube';
    default:
      return 'doc';
  }
}

function detailOf(file: ComposeFile): string {
  if (file.state === 'refused') return file.error ?? 'Not attached.';
  if (file.state === 'uploading') return `Uploading… ${Math.round(file.progress * 100)}% of ${formatBytes(file.size)}`;
  const upload = file.upload!;
  return `${inboxAttachmentKindLabel(upload.kind, upload.name, upload.media_type)}, ${formatBytes(upload.size)}`;
}

/** True for the first PASTED_UNDO_MS after `at`, then false (re-rendered when it turns). */
function useFresh(at: number): boolean {
  const left = at + PASTED_UNDO_MS - Date.now();
  const [fresh, setFresh] = useState(left > 0);
  useEffect(() => {
    if (left <= 0) {
      setFresh(false);
      return;
    }
    setFresh(true);
    const timer = setTimeout(() => setFresh(false), left);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at]);
  return fresh;
}

/**
 * A long paste as a file (approval "inbox-paste-attachment", Option A): the
 * ordinary tile, its name the paste's first words, its second line "Pasted
 * text · 46.9 KB". For its first 10 seconds that line reads "Pasted text ·
 * Undo"; after them, hover or keyboard focus swaps it in place for "Put back
 * in box" (inbox.css: the two share one grid cell, so nothing moves). On a
 * phone, or a screen with no hover, the line keeps the size and "Undo", then
 * "Put back", stands beside the × with a 44 px target. Each puts the words
 * back in the box (`onPutBack`).
 */
function PastedTextTile({ file, pasted, onRemove, onPutBack }: { file: ComposeFile; pasted: PastedText; onRemove: (key: string) => void; onPutBack: (key: string) => void }) {
  const fresh = useFresh(pasted.at);
  const size = `Pasted text · ${formatBytes(file.size)}`;
  return (
    <div
      className={`ib-cp-file ib-pt${file.state === 'refused' ? ' ib-refused' : ''}`}
      data-compose-file={file.state}
      data-compose-file-name={file.name}
      data-pasted-text=""
      data-pasted-fresh={fresh ? '' : undefined}
    >
      <span className="ib-fi">
        <Icon name="doc" size={16} />
      </span>
      <span className="ib-att-text">
        <span className="ib-nm ib-pt-nm" dir="auto">
          {pasted.preview}
        </span>
        {file.state === 'refused' ? (
          <span className="ib-cp-ferr" role="alert">
            {file.error ?? 'Not attached.'}
          </span>
        ) : (
          <span className="ib-kd ib-pt-line" data-pasted-line="">
            <span className="ib-pt-size">{size}</span>
            {fresh ? (
              <span className="ib-pt-undo">
                Pasted text ·{' '}
                <button type="button" className="ib-pt-act" data-pasted-undo="" onClick={() => onPutBack(file.key)}>
                  Undo
                </button>
              </span>
            ) : (
              <button type="button" className="ib-pt-act ib-pt-back" data-pasted-put-back="" onClick={() => onPutBack(file.key)}>
                Put back in box
              </button>
            )}
          </span>
        )}
        {file.state === 'uploading' && (
          <span className="ib-cp-prog" aria-hidden="true">
            <i style={{ width: `${Math.round(file.progress * 100)}%` }} />
          </span>
        )}
      </span>
      <button type="button" className="ib-pt-side" data-pasted-side="" onClick={() => onPutBack(file.key)}>
        {fresh ? 'Undo' : 'Put back'}
      </button>
      <button type="button" className="ib-cp-fx" aria-label={file.state === 'uploading' ? `Stop uploading ${file.name}` : `Remove ${file.name}`} onClick={() => onRemove(file.key)}>
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

export function ComposeFileTiles({ files, onRemove, onPutBack }: { files: readonly ComposeFile[]; onRemove: (key: string) => void; onPutBack?: (key: string) => void }) {
  if (files.length === 0) return null;
  return (
    <div className="ib-cp-files" data-compose-files="">
      {files.map((file) =>
        file.pasted && onPutBack ? (
          <PastedTextTile key={file.key} file={file} pasted={file.pasted} onRemove={onRemove} onPutBack={onPutBack} />
        ) : (
        <div
          key={file.key}
          className={`ib-cp-file${file.state === 'refused' ? ' ib-refused' : ''}`}
          data-compose-file={file.state}
          data-compose-file-name={file.name}
        >
          {file.preview ? (
            <span className="ib-fi ib-thumb">
              <img src={file.preview} alt="" draggable={false} />
            </span>
          ) : (
            <span className="ib-fi">
              <Icon name={file.state === 'refused' ? 'doc' : iconFor(file.upload)} size={16} />
            </span>
          )}
          <span className="ib-att-text">
            <FileName name={file.name} className="ib-nm" />
            <span className={file.state === 'refused' ? 'ib-cp-ferr' : 'ib-kd'} role={file.state === 'refused' ? 'alert' : undefined}>
              {detailOf(file)}
            </span>
            {file.state === 'uploading' && (
              <span className="ib-cp-prog" aria-hidden="true">
                <i style={{ width: `${Math.round(file.progress * 100)}%` }} />
              </span>
            )}
          </span>
          <button type="button" className="ib-cp-fx" aria-label={file.state === 'uploading' ? `Stop uploading ${file.name}` : `Remove ${file.name}`} onClick={() => onRemove(file.key)}>
            <Icon name="x" size={14} />
          </button>
        </div>
        ),
      )}
    </div>
  );
}
