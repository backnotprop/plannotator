import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent } from 'react';
import { inboxAttachmentKindLabel, readInboxAttachmentKind, type InboxDraftFile, type InboxDraftPasted, type InboxUpload } from '@plannotator/core/inbox-types';
import type { DraftFileUploader, ReplyDraftFileRef } from '@plannotator/core/inbox-reply-draft';
import { InboxApiError } from '../api';
import { ownAttachmentInPaste, type OwnAttachmentPaste } from './reusePaste';
import type { ReuseSource } from '../reuse';
import { httpDraftFileUploader } from '../replyDraftHttp';
import { formatBytes } from '../format';
import { Icon, type IconName } from '../icons';
import { FileName } from '../components/FileName';
import { Tip } from '../components/Tip';
import { isPhone } from '../phone';
import { chosenFiles, clipboardHasText, pastedFiles, pastedImageOwnLink } from './paste';
import { PASTED_UNDO_MS, boxText, isLongPaste, mapAnchor, pastedPreview, pastedTextName, putTextBack } from './pastedText';
import { newUuid } from '../uuid';

export interface ComposeFile {
  key: string;
  name: string;
  size: number;
  state: 'uploading' | 'done' | 'refused';
  progress: number;
  upload: InboxUpload | null;
  error: string | null;
  preview: string | null;
  pasted?: PastedText | null;
  reuse?: { sha256: string } | null;
  flash?: boolean;
}

export interface PastedText {
  text: string | null;
  preview: string;
  at: number;
}

export interface ComposeFilesText {
  value: string;
  set: (next: string) => void;
}

interface PasteAnchor {
  at: number;
  lead: string;
}

const fromUpload = (file: InboxDraftFile): ComposeFile => {
  const { pasted, ...upload } = file;
  return {
    key: upload.upload_id,
    name: upload.name,
    size: upload.size,
    state: 'done',
    progress: 1,
    upload,
    error: null,
    preview: null,
    ...(pasted ? { pasted: { text: null, preview: pasted.preview, at: 0 } } : {}),
  };
};

const anchorsOf = (files: readonly InboxDraftFile[]): Map<string, PasteAnchor> =>
  new Map(files.flatMap((file) => (file.pasted ? [[file.upload_id, { at: file.pasted.at, lead: file.pasted.lead ?? '' }] as const] : [])));

export interface DraftPastedFile {
  upload_id: string;
  pasted: InboxDraftPasted;
}

export function pastedSignature(files: readonly { upload_id: string }[]): string {
  return files.map((file) => file.upload_id).join(',');
}

export function attachedAnnouncement(names: readonly string[]): string {
  return names.length === 1 ? `Attached ${names[0]}` : `Attached ${names.length} files: ${names.join(', ')}`;
}

export function useComposeFiles(
  initial: readonly InboxDraftFile[],
  options: {
    onPasted?: (names: string[]) => void;
    onAlready?: (name: string) => void;
    machine?: string | null;
    text?: ComposeFilesText;
    onPutBack?: () => void;
    uploader?: DraftFileUploader;
    onUnmountUploads?: (uploads: Promise<InboxUpload | null>[]) => void;
  } = {},
) {
  const [files, setFiles] = useState<ComposeFile[]>(() => initial.map(fromUpload));
  const aborts = useRef(new Map<string, AbortController>());
  const inFlight = useRef(new Map<string, Promise<InboxUpload | null>>());
  const previews = useRef(new Map<string, string>());
  const filesRef = useRef<ComposeFile[]>(files);
  filesRef.current = files;
  const onPasted = useRef(options.onPasted);
  onPasted.current = options.onPasted;
  const onAlready = useRef(options.onAlready);
  onAlready.current = options.onAlready;
  const onPutBack = useRef(options.onPutBack);
  onPutBack.current = options.onPutBack;
  const machine = useRef(options.machine ?? null);
  machine.current = options.machine ?? null;
  const ownUploader = useRef<DraftFileUploader | null>(null);
  if (ownUploader.current === null) ownUploader.current = httpDraftFileUploader(() => machine.current);
  const uploader = useRef(options.uploader ?? ownUploader.current);
  uploader.current = options.uploader ?? ownUploader.current;
  const onUnmountUploads = useRef(options.onUnmountUploads);
  onUnmountUploads.current = options.onUnmountUploads;
  const text = useRef(options.text);
  text.current = options.text;
  const anchors = useRef<Map<string, PasteAnchor>>(null as unknown as Map<string, PasteAnchor>);
  if (anchors.current === null) anchors.current = anchorsOf(initial);
  const anchoredIn = useRef(options.text?.value ?? '');
  const followTo = (value: string) => {
    if (value === anchoredIn.current) return;
    for (const anchor of anchors.current.values()) anchor.at = mapAnchor(anchoredIn.current, value, anchor.at);
    anchoredIn.current = value;
  };
  if (options.text) followTo(options.text.value);
  const follow = useCallback(() => {
    if (text.current) followTo(text.current.value);
  }, []);
  const undoArm = useRef<{ key: string; field: HTMLTextAreaElement } | null>(null);
  const reading = useRef(new Set<string>());
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
    const key = `local-${newUuid()}`;
    const preview = file.type.startsWith('image/') && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null;
    if (preview) previews.current.set(key, preview);
    setFiles((current) => [...current, { key, name: file.name, size: file.size, state: 'uploading', progress: 0, upload: null, error: null, preview, ...(pasted ? { pasted } : {}) }]);
    const controller = new AbortController();
    aborts.current.set(key, controller);
    const settled = uploader.current
      .upload(file, { signal: controller.signal, onProgress: (loaded, total) => patch(key, { progress: total > 0 ? loaded / total : 0 }) })
      .then((upload) => {
        patch(key, { state: 'done', progress: 1, upload });
        return upload;
      })
      .catch((cause) => {
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
          patch(key, { state: 'refused', error: cause instanceof InboxApiError ? cause.message : 'Not attached: the upload failed.' });
        }
        return null;
      })
      .finally(() => {
        aborts.current.delete(key);
        inFlight.current.delete(key);
      });
    inFlight.current.set(key, settled);
    return key;
  };

  const add = useCallback((list: Iterable<File>): string[] => {
    const keys: string[] = [];
    for (const file of list) keys.push(addOne(file));
    return keys;
  }, []);

  const holding = useCallback((sha256: string): ComposeFile | undefined => filesRef.current.find((file) => file.state !== 'refused' && (file.reuse?.sha256 === sha256 || file.upload?.sha256 === sha256 || file.upload?.shown_sha256 === sha256)), []);

  const flash = (key: string) => {
    patch(key, { flash: true });
    setTimeout(() => patch(key, { flash: false }), 900);
  };

  const addExisting = useCallback((source: ReuseSource) => {
    const here = holding(source.sha256);
    if (here) {
      flash(here.key);
      onAlready.current?.(source.name);
      return;
    }
    const reuse = uploader.current.reuse;
    if (!reuse) return;
    const tried = filesRef.current.filter((file) => file.state === 'refused' && file.reuse?.sha256 === source.sha256).map((file) => file.key);
    if (tried.length > 0) {
      filesRef.current = filesRef.current.filter((file) => !tried.includes(file.key));
      setFiles((current) => current.filter((file) => !tried.includes(file.key)));
      tried.forEach(release);
    }
    const key = `local-${newUuid()}`;
    const fresh: ComposeFile = { key, name: source.name, size: source.size, state: 'uploading', progress: 0, upload: null, error: null, preview: source.preview, reuse: { sha256: source.sha256 } };
    filesRef.current = [...filesRef.current, fresh];
    setFiles((current) => [...current, fresh]);
    const controller = new AbortController();
    aborts.current.set(key, controller);
    const settled = reuse(source.id, source.version, { signal: controller.signal, sha256: source.sha256 })
      .then((upload) => {
        const here = filesRef.current.find((file) => file.key !== key && file.state !== 'refused' && file.upload?.sha256 === upload.sha256);
        if (here) {
          filesRef.current = filesRef.current.filter((file) => file.key !== key);
          setFiles((current) => current.filter((file) => file.key !== key));
          patch(here.key, { reuse: { sha256: source.sha256 }, flash: true });
          setTimeout(() => patch(here.key, { flash: false }), 900);
          onAlready.current?.(source.name);
          return null;
        }
        patch(key, { state: 'done', progress: 1, upload });
        return upload;
      })
      .catch((cause) => {
        if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
          patch(key, { state: 'refused', error: cause instanceof InboxApiError ? cause.message : 'Not attached: that file could not be added.' });
        }
        return null;
      })
      .finally(() => {
        aborts.current.delete(key);
        inFlight.current.delete(key);
      });
    inFlight.current.set(key, settled);
    onPasted.current?.([source.name]);
  }, [holding]);

  const addPasted = (own: OwnAttachmentPaste, pictures: readonly File[]) => {
    const key = `local-${newUuid()}`;
    const fresh: ComposeFile = { key, name: 'Adding…', size: 0, state: 'uploading', progress: 0, upload: null, error: null, preview: own.src, reuse: { sha256: '' } };
    filesRef.current = [...filesRef.current, fresh];
    setFiles((current) => [...current, fresh]);
    const drop = () => {
      filesRef.current = filesRef.current.filter((file) => file.key !== key);
      setFiles((current) => current.filter((file) => file.key !== key));
    };
    const controller = new AbortController();
    aborts.current.set(key, controller);
    const settled = uploader.current.reuse!(own.id, own.version, { signal: controller.signal })
      .then((upload) => {
        const here = holding(upload.sha256);
        if (here && here.key !== key) {
          drop();
          flash(here.key);
          onAlready.current?.(upload.name);
          return null;
        }
        patch(key, { state: 'done', progress: 1, upload, name: upload.name, size: upload.size, reuse: { sha256: upload.sha256 } });
        onPasted.current?.([upload.name]);
        return upload;
      })
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return null;
        if (pictures.length > 0) {
          drop();
          namesRef.current = [...namesRef.current, ...pictures.map((file) => file.name)];
          add(pictures);
          onPasted.current?.(pictures.map((file) => file.name));
        } else {
          patch(key, { state: 'refused', name: 'Picture', error: cause instanceof InboxApiError ? cause.message : 'Not attached: that file could not be added.' });
        }
        return null;
      })
      .finally(() => {
        aborts.current.delete(key);
        inFlight.current.delete(key);
      });
    inFlight.current.set(key, settled);
  };

  const removeHolding = useCallback((sha256: string) => {
    const here = holding(sha256);
    if (!here) return;
    release(here.key);
    filesRef.current = filesRef.current.filter((file) => file.key !== here.key);
    setFiles((current) => current.filter((file) => file.key !== here.key));
  }, [holding]);

  const remove = useCallback((key: string) => {
    release(key);
    setFiles((current) => current.filter((file) => file.key !== key));
  }, []);

  const forget = useCallback((keys: ReadonlySet<string>) => {
    for (const key of keys) release(key);
    setFiles((current) => current.filter((file) => !keys.has(file.key)));
  }, []);

  const detach = useCallback((): Promise<InboxUpload | null>[] => {
    const out: Promise<InboxUpload | null>[] = [];
    for (const file of filesRef.current) {
      const settled = inFlight.current.get(file.key);
      if (file.state !== 'uploading' || !settled || !aborts.current.has(file.key)) continue;
      aborts.current.delete(file.key);
      out.push(settled);
    }
    return out;
  }, []);

  const reset = useCallback(() => {
    for (const key of [...aborts.current.keys(), ...previews.current.keys(), ...anchors.current.keys()]) release(key);
    undoArm.current = null;
    setFiles((current) => (current.length === 0 ? current : []));
  }, []);

  const current = useCallback(() => filesRef.current, []);

  const namesRef = useRef<string[]>([]);
  namesRef.current = files.map((file) => file.name);

  /** Read from `event.clipboardData` synchronously, never the async clipboard. Prevented only when the clipboard holds files and no text. */
  const takeText = useCallback((words: string, at: number, options: { field?: HTMLTextAreaElement | null; lead?: string } = {}) => {
    const name = pastedTextName(new Date(), namesRef.current);
    namesRef.current = [...namesRef.current, name];
    const key = addOne(new File([words], name, { type: 'text/plain' }), { text: boxText(words), preview: pastedPreview(words), at: Date.now() });
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
      const own = !machine.current && uploader.current.reuse ? ownAttachmentInPaste(data, location.origin) : null;
      if (own) {
        event.preventDefault();
        addPasted(own, list);
        return true;
      }
      if (list.length === 0) return pasteLongText(event);
      const ownLink = pastedImageOwnLink(data, phone);
      namesRef.current = [...namesRef.current, ...list.map((file) => file.name)];
      add(list);
      onPasted.current?.(list.map((file) => file.name));
      const long = !ownLink && pasteLongText(event);
      if (!long && (!clipboardHasText(data) || ownLink)) event.preventDefault();
      return true;
    },
    [add],
  );

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

  const putBack = useCallback((key: string, field: HTMLTextAreaElement | null = null): boolean => {
    const host = text.current;
    const file = filesRef.current.find((f) => f.key === key);
    if (!host || !file?.pasted || field?.readOnly) return false;
    if (file.pasted.text !== null) return insertBack(key, file.pasted.text, field);
    const upload = file.upload;
    if (!upload || reading.current.has(key)) return false;
    reading.current.add(key);
    patch(key, { error: null });
    uploader.current
      .readText(upload.upload_id)
      .then((words) => {
        if (!filesRef.current.some((f) => f.key === key)) return;
        if (field?.readOnly) return;
        insertBack(key, boxText(words), field);
      })
      .catch(() => patch(key, { error: 'That pasted text could not be read back. It is still attached.' }))
      .finally(() => reading.current.delete(key));
    return true;
  }, []);

  const insertBack = (key: string, words: string, field: HTMLTextAreaElement | null): boolean => {
    const host = text.current;
    if (!host) return false;
    const value = host.value;
    if (anchoredIn.current !== value) {
      for (const anchor of anchors.current.values()) anchor.at = mapAnchor(anchoredIn.current, value, anchor.at);
    }
    const own = anchors.current.get(key) ?? { at: value.length, lead: '' };
    const inserted = own.lead + words;
    const back = putTextBack(value, own.at, inserted);
    const place = back.caret - inserted.length;
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
  };

  const pastedDraft = useCallback((words?: string): DraftPastedFile[] => {
    const from = anchoredIn.current;
    const out: DraftPastedFile[] = [];
    for (const file of filesRef.current) {
      const anchor = anchors.current.get(file.key);
      if (!file.pasted || !anchor || file.state !== 'done' || !file.upload) continue;
      const at = words === undefined || words === from ? anchor.at : mapAnchor(from, words, anchor.at);
      const length = words ?? from;
      out.push({
        upload_id: file.upload.upload_id,
        pasted: { at: Math.min(at, length.length), ...(anchor.lead ? { lead: anchor.lead } : {}), preview: file.pasted.preview.slice(0, 200) },
      });
    }
    return out;
  }, []);

  const draftFiles = useCallback((words?: string): ReplyDraftFileRef[] => {
    const pasted = new Map(pastedDraft(words).map((file) => [file.upload_id, file]));
    return filesRef.current.flatMap((file) =>
      file.state === 'done' && file.upload ? [pasted.get(file.upload.upload_id) ?? { upload_id: file.upload.upload_id }] : [],
    );
  }, [pastedDraft]);

  const restoreDraft = useCallback((list: readonly InboxDraftFile[], words: string, mode: 'replace' | 'add' = 'replace', alsoKeep: readonly string[] = []) => {
    const wanted = new Set([...list.map((file) => file.upload_id), ...alsoKeep]);
    const here = new Set(filesRef.current.filter((file) => file.upload).map((file) => file.upload!.upload_id));
    const keep = (file: ComposeFile) => mode === 'add' || !file.upload || wanted.has(file.upload.upload_id);
    for (const file of filesRef.current) {
      if (!keep(file)) release(file.key);
      else if (file.pasted && !file.upload) {
        const anchor = anchors.current.get(file.key);
        if (anchor) anchor.at = Math.min(mapAnchor(anchoredIn.current, words, anchor.at), words.length);
      }
    }
    for (const file of list) {
      if (!file.pasted) continue;
      const key = filesRef.current.find((f) => f.upload?.upload_id === file.upload_id)?.key ?? file.upload_id;
      anchors.current.set(key, { at: file.pasted.at, lead: file.pasted.lead ?? '' });
    }
    anchoredIn.current = words;
    undoArm.current = null;
    const added = list.filter((file) => !here.has(file.upload_id)).map(fromUpload);
    const next = [...filesRef.current.filter(keep), ...added];
    filesRef.current = next;
    namesRef.current = next.map((file) => file.name);
    setFiles(next);
  }, []);

  useLayoutEffect(() => {
    const pending = caretAfter.current;
    if (!pending || pending.field.value.length < pending.caret) return;
    caretAfter.current = null;
    if (!pending.field.isConnected) return;
    pending.field.focus();
    pending.field.setSelectionRange(pending.caret, pending.caret);
  });

  useEffect(() => {
    const onBeforeInput = (event: Event) => {
      const arm = undoArm.current;
      if (!arm || event.target !== arm.field) return;
      undoArm.current = null;
      if ((event as InputEvent).inputType !== 'historyUndo' || !event.cancelable) return;
      event.preventDefault();
      putBack(arm.key, arm.field);
    };
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
      const keep = onUnmountUploads.current;
      if (keep) {
        const handed = [...aborts.current.keys()].flatMap((key) => {
          const settled = inFlight.current.get(key);
          return settled ? [settled] : [];
        });
        aborts.current.clear();
        if (handed.length > 0) keep(handed);
      }
      for (const controller of aborts.current.values()) controller.abort();
      for (const url of previews.current.values()) URL.revokeObjectURL(url);
      previews.current.clear();
    },
    [],
  );

  const canReuse = !options.machine && Boolean(uploader.current.reuse);
  const uploaded = files.filter((file) => file.state === 'done' && file.upload).map((file) => file.upload!);
  const uploading = files.some((file) => file.state === 'uploading');
  return { files, add, canReuse, addExisting, holding, removeHolding, attach, remove, forget, reset, detach, current, paste, takeText, putBack, pastedDraft, draftFiles, restoreDraft, follow, uploaded, uploading };
}

/** A phone's picker offers the photo library and Files (iOS gives no Paste for a picture in a text field). */
const PHONE_ACCEPT = 'image/*,*/*';

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
    case 'audio':
      return 'music';
    case 'html':
    case 'code':
      return 'code';
    case 'file':
      return 'cube';
    default:
      return 'doc';
  }
}

function detailOf(file: ComposeFile): { words: string; size: string } {
  const size = formatBytes(file.state === 'uploading' ? file.size : file.upload!.size);
  if (file.state === 'uploading') return file.reuse ? { words: 'Adding…', size: ` ${size}` } : { words: `Uploading… ${Math.round(file.progress * 100)}%`, size: ` of ${size}` };
  const upload = file.upload!;
  return { words: inboxAttachmentKindLabel(upload.kind, upload.name, upload.media_type), size: `, ${size}` };
}

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
        {file.state === 'refused' || file.error ? (
          <span className="ib-cp-ferr" role="alert">
            {file.error ?? 'Not attached.'}
          </span>
        ) : (
          <span className="ib-kd ib-pt-line" data-pasted-line="">
            <span className="ib-pt-size">{size}</span>
            {/* One button in both states, so focus on Undo stays on it at the swap. */}
            <span className={fresh ? 'ib-pt-undo' : 'ib-pt-back'}>
              {fresh ? 'Pasted text · ' : null}
              <button
                type="button"
                className="ib-pt-act"
                data-pasted-undo={fresh ? '' : undefined}
                data-pasted-put-back={fresh ? undefined : ''}
                aria-label={fresh ? `Undo paste of ${file.name}` : `Put back in box: ${file.name}`}
                onClick={() => onPutBack(file.key)}
              >
                {fresh ? 'Undo' : 'Put back in box'}
              </button>
            </span>
          </span>
        )}
        {file.state === 'uploading' && (
          <span className="ib-cp-prog" aria-hidden="true">
            <i style={{ width: `${Math.round(file.progress * 100)}%` }} />
          </span>
        )}
      </span>
      <button
        type="button"
        className="ib-pt-side"
        data-pasted-side=""
        aria-label={fresh ? `Undo paste of ${file.name}` : `Put back: ${file.name}`}
        onClick={() => onPutBack(file.key)}
      >
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
          className={`ib-cp-file${file.state === 'refused' ? ' ib-refused' : ''}${file.flash ? ' ib-cp-flash' : ''}`}
          data-compose-file={file.state}
          data-compose-file-name={file.name}
          data-compose-file-reuse={file.reuse ? '' : undefined}
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
            {file.state === 'refused' ? (
              <span className="ib-cp-ferr" role="alert">
                {file.error ?? 'Not attached.'}
              </span>
            ) : (
              <span className="ib-kd ib-kd-split">
                <span className="ib-kd-w">{detailOf(file).words}</span>
                <span className="ib-kd-n">{detailOf(file).size}</span>
              </span>
            )}
            {file.state === 'uploading' && !file.reuse && (
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
