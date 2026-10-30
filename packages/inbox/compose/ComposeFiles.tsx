import { useCallback, useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent } from 'react';
import { inboxAttachmentKindLabel, readInboxAttachmentKind, type InboxUpload } from '@plannotator/core/inbox-types';
import { InboxApiError, uploadFile } from '../api';
import { formatBytes } from '../format';
import { Icon, type IconName } from '../icons';
import { FileName } from '../components/FileName';
import { Tip } from '../components/Tip';
import { isPhone } from '../phone';
import { chosenFiles, clipboardHasText, pastedFiles, pastedImageOwnLink } from './paste';

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
 */
export function useComposeFiles(initial: readonly InboxUpload[], options: { onPasted?: (names: string[]) => void } = {}) {
  const [files, setFiles] = useState<ComposeFile[]>(() => initial.map(fromUpload));
  const aborts = useRef(new Map<string, AbortController>());
  /** Each local preview's object URL by its file's key, freed when the file goes. */
  const previews = useRef(new Map<string, string>());
  const filesRef = useRef<ComposeFile[]>(files);
  filesRef.current = files;
  const onPasted = useRef(options.onPasted);
  onPasted.current = options.onPasted;
  const release = (key: string) => {
    aborts.current.get(key)?.abort();
    aborts.current.delete(key);
    const url = previews.current.get(key);
    if (url) URL.revokeObjectURL(url);
    previews.current.delete(key);
  };
  const patch = (key: string, change: Partial<ComposeFile>) => setFiles((current) => current.map((file) => (file.key === key ? { ...file, ...change } : file)));

  const add = useCallback((list: Iterable<File>) => {
    for (const file of list) {
      const key = `local-${crypto.randomUUID()}`;
      const preview = file.type.startsWith('image/') && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null;
      if (preview) previews.current.set(key, preview);
      setFiles((current) => [...current, { key, name: file.name, size: file.size, state: 'uploading', progress: 0, upload: null, error: null, preview }]);
      const controller = new AbortController();
      aborts.current.set(key, controller);
      uploadFile(file, { signal: controller.signal, onProgress: (loaded, total) => patch(key, { progress: total > 0 ? loaded / total : 0 }) })
        .then((upload) => patch(key, { state: 'done', progress: 1, upload }))
        .catch((cause) => {
          if (cause instanceof DOMException && cause.name === 'AbortError') return;
          patch(key, { state: 'refused', error: cause instanceof InboxApiError ? cause.message : 'Not attached: the upload failed.' });
        })
        .finally(() => aborts.current.delete(key));
    }
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
    for (const key of [...aborts.current.keys(), ...previews.current.keys()]) release(key);
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
  const paste = useCallback(
    (event: ReactClipboardEvent<HTMLElement>): boolean => {
      if (event.defaultPrevented) return false;
      const data = event.clipboardData;
      const phone = isPhone();
      const list = pastedFiles(data, namesRef.current, new Date(), { phone });
      if (list.length === 0) return false;
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
  return { files, add, attach, remove, forget, reset, current, paste, uploaded, uploading };
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

export function ComposeFileTiles({ files, onRemove }: { files: readonly ComposeFile[]; onRemove: (key: string) => void }) {
  if (files.length === 0) return null;
  return (
    <div className="ib-cp-files" data-compose-files="">
      {files.map((file) => (
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
      ))}
    </div>
  );
}
