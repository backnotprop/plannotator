import { useCallback, useEffect, useRef, useState } from 'react';
import { inboxAttachmentKindLabel, readInboxAttachmentKind, type InboxUpload } from '@plannotator/core/inbox-types';
import { InboxApiError, uploadFile } from '../api';
import { formatBytes } from '../format';
import { Icon, type IconName } from '../icons';
import { FileName } from '../components/FileName';

/**
 * Compose's files: each one the person picked or dropped, uploaded at once
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

/** The files of one compose session, and its uploads. */
export function useComposeFiles(initial: readonly InboxUpload[]) {
  const [files, setFiles] = useState<ComposeFile[]>(() => initial.map(fromUpload));
  const aborts = useRef(new Map<string, AbortController>());
  const previews = useRef(new Set<string>());
  const patch = (key: string, change: Partial<ComposeFile>) => setFiles((current) => current.map((file) => (file.key === key ? { ...file, ...change } : file)));

  const add = useCallback((list: Iterable<File>) => {
    for (const file of list) {
      const key = `local-${crypto.randomUUID()}`;
      const preview = file.type.startsWith('image/') && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null;
      if (preview) previews.current.add(preview);
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
    aborts.current.get(key)?.abort();
    aborts.current.delete(key);
    setFiles((current) => current.filter((file) => file.key !== key));
  }, []);

  useEffect(
    () => () => {
      for (const controller of aborts.current.values()) controller.abort();
      for (const url of previews.current) URL.revokeObjectURL(url);
    },
    [],
  );

  const uploaded = files.filter((file) => file.state === 'done' && file.upload).map((file) => file.upload!);
  const uploading = files.some((file) => file.state === 'uploading');
  return { files, add, remove, uploaded, uploading };
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
