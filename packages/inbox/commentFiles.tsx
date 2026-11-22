/**
 * Files on a file's own comment row (the owner, 2026-11-22: "I need to be able to attach images to this comment box
 * on top of files/artifacts"): the image's, the film's and the HTML page's rows, beside the thread and in full screen's
 * Comment tab. The reply box's own parts: its paperclip (`AttachFilesButton`), its tiles (`ComposeFileTiles`), its
 * paste and its drop (`useComposeFiles`, `useFileDrop`), so the uploads, the limits and the refusals are the reply's.
 *
 * Each finished upload goes on the comment as an `images` entry `{ path: "<upl id>/<file>", name }` (a picture) or
 * with `kind: "file"` (anything else), the same entries the comment card's pictures and files are
 * (commentPictures.tsx), so the Send carries them as the reply's attachments and the feedback names them under
 * "Attached images" / "Attached files". No provider (the tour, the phone app's surface): no paperclip, no paste, no drop.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ClipboardEvent, type ReactNode } from 'react';
import type { DraftFileUploader } from '@plannotator/core/inbox-reply-draft';
import type { InboxUpload } from '@plannotator/core/inbox-types';
import type { ImageAttachment } from '@plannotator/ui/types';
import { commentImageOf } from './commentPictureFiles';
import { AttachFilesButton, ComposeFileTiles, useComposeFiles, useFileDrop } from './compose/ComposeFiles';
import { inboxApi, reuseAttachment, uploadFile } from './api';
import { rememberMachine } from './inboxUrl';
import { Icon } from './icons';

/** Where a comment row's files go: the thread's machine, each file named so no two of this window's comments share a name. */
export interface CommentFilesHost {
  uploader: DraftFileUploader;
  machine: string | null;
}

export const CommentFilesContext = createContext<CommentFilesHost | null>(null);

/** The uploader for a thread's comment rows: the reply box's uploads, each named by `name` (commentPictures.tsx `freshName`). */
export function commentFilesHost(machine: string | null, name: (file: string) => string): CommentFilesHost {
  return {
    machine,
    uploader: {
      upload: async (file, options) => {
        const named = name(file.name);
        const upload = await uploadFile(named === file.name ? file : new File([file], named, { type: file.type, lastModified: file.lastModified }), {
          machine,
          signal: options.signal,
          onProgress: options.onProgress,
        });
        if (machine) rememberMachine([upload.upload_id], machine);
        return upload;
      },
      readText: async (uploadId) => (await inboxApi.uploadText(uploadId, machine)).text,
      ...(machine ? {} : { reuse: (attachmentId: string, version: 'current' | 'sent', options: { signal: AbortSignal; sha256?: string }) => reuseAttachment(attachmentId, version, options) }),
    },
  };
}

/**
 * Full screen's card, on its Comment tab: a drop anywhere on the card goes to the row's files, as a drop anywhere on
 * it goes to the reply's on the Reply tab. A row that takes files registers; the last one registered is the one shown
 * (an HTML page's pin card over its page row, on a phone).
 */
export interface CommentDropSlot {
  register: (onFiles: (files: FileList) => void) => () => void;
}
export const CommentDropContext = createContext<CommentDropSlot | null>(null);

/** For the card: the slot to hand the row, whether a row takes files, and the drop to call. */
export function useCommentDropSlot() {
  const targets = useRef<((files: FileList) => void)[]>([]);
  const [takes, setTakes] = useState(false);
  const slot = useMemo<CommentDropSlot>(
    () => ({
      register: (onFiles) => {
        targets.current = [...targets.current, onFiles];
        setTakes(true);
        return () => {
          targets.current = targets.current.filter((target) => target !== onFiles);
          setTakes(targets.current.length > 0);
        };
      },
    }),
    [],
  );
  const drop = useCallback((files: FileList) => targets.current[targets.current.length - 1]?.(files), []);
  return { slot, takes, drop };
}

export interface CommentFiles {
  /** The row takes files (a thread's Inbox is above it). */
  on: boolean;
  /** The paperclip, for the row's tools. Null when off. */
  clip: ReactNode;
  /** The tiles of what is added, for over the row's field. Null when none. */
  tiles: ReactNode;
  /** For the row's own element: a paste of files attaches them; text pastes as text. */
  onPaste: (event: ClipboardEvent<HTMLElement>) => void;
  /** Beside the thread: the row's own drop target (its handlers and the "Drop to attach" cover). In full screen the card takes the drop. */
  drop: { handlers: ReturnType<typeof useFileDrop>['handlers']; cover: ReactNode } | null;
  /** The finished uploads as the comment's `images` entries. */
  images: () => ImageAttachment[];
  /** Any file still uploading: Comment waits. */
  uploading: boolean;
  /** How many files are uploaded and ready to go with the comment. */
  ready: number;
  /** The finished uploads, for the row's draft as the file closes. */
  kept: () => InboxUpload[];
  /** The comment was saved: its files go with it. */
  clear: () => void;
  /** Files to attach (a drop the card hands over). */
  add: (list: FileList) => void;
}

/** Full screen's card hands its drops on the Comment tab to these files (for a row whose files are held above the card). */
export function useCommentDropTarget(files: Pick<CommentFiles, 'on' | 'add'>): void {
  const slot = useContext(CommentDropContext);
  const { on, add } = files;
  useEffect(() => (slot && on ? slot.register(add) : undefined), [slot, on, add]);
}

/**
 * A comment row's files. `initial`: the uploads its draft kept (the file closed and opened again). `phone`: the
 * paperclip's size and its picker (the photo library), as the reply box's.
 */
export function useCommentFiles({ initial, phone = false, focus }: { initial?: readonly InboxUpload[] | null; phone?: boolean; focus?: () => void }): CommentFiles {
  const host = useContext(CommentFilesContext);
  const slot = useContext(CommentDropContext);
  const on = host !== null;
  const files = useComposeFiles(initial ?? [], { machine: host?.machine ?? null, ...(host ? { uploader: host.uploader } : {}) });
  const attach = useCallback((list: FileList) => (phone ? files.attach(list) : files.add(list)), [files.attach, files.add, phone]);
  const own = useFileDrop((list) => files.add(list), on && slot === null);
  // In full screen's card the drop is the card's: it hands it here.
  const add = useCallback((list: FileList) => void files.add(list), [files.add]);
  useCommentDropTarget({ on, add });
  const clip = on ? <AttachFilesButton className="ib-fvb ib-fcomp-clip ib-cclip" iconSize={phone ? 18 : 15} phone={phone} inputData="data-comment-attach" onFiles={attach} /> : null;
  const tiles =
    files.files.length > 0 ? (
      <div className="ib-rfiles ib-cfiles" data-comment-files="">
        <ComposeFileTiles
          files={files.files}
          onRemove={(key) => {
            files.remove(key);
            // The × goes with its tile: focus stays in the comment, as in the reply box.
            focus?.();
          }}
        />
      </div>
    ) : null;
  const current = files.current;
  return {
    on,
    clip,
    tiles,
    onPaste: (event) => {
      if (on) files.paste(event);
    },
    drop:
      on && slot === null
        ? {
            handlers: own.handlers,
            cover: own.over ? (
              <div className="ib-rdrop" aria-hidden="true" data-comment-drop="">
                <Icon name="clip" size={18} />
                Drop to attach
              </div>
            ) : null,
          }
        : null,
    images: () => current().flatMap((file) => (file.state === 'done' && file.upload ? [commentImageOf(file.upload)] : [])),
    uploading: files.uploading,
    ready: files.uploaded.length,
    kept: () => current().flatMap((file) => (file.state === 'done' && file.upload ? [file.upload] : [])),
    clear: files.reset,
    add,
  };
}
