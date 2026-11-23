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
import type { ComposeFilesText } from './compose/ComposeFiles';
import { announce } from './panes/paneDrag';
import type { InboxUpload } from '@plannotator/core/inbox-types';
import type { ImageAttachment } from '@plannotator/ui/types';
import { commentImageOf } from './commentPictureFiles';
import { AttachFilesButton, ComposeFileTiles, attachedAnnouncement, useComposeFiles, useFileDrop } from './compose/ComposeFiles';
import { inboxApi, reuseAttachment, uploadFile } from './api';
import { rememberMachine } from './inboxUrl';
import { Icon } from './icons';

/** Where a comment row's files go: the thread's machine, each file named so no two of this window's comments share a name. */
export interface CommentFilesHost {
  uploader: DraftFileUploader;
  machine: string | null;
}

export const CommentFilesContext = createContext<CommentFilesHost | null>(null);

/**
 * The uploader for a thread's comment rows: the reply box's uploads, each named by `name` (commentPictures.tsx
 * `freshName`); the name of an upload that failed is given back with `release`, as the comment card's transport does.
 */
export function commentFilesHost(machine: string | null, name: (file: string) => string, release: (file: string) => void = () => {}): CommentFilesHost {
  return {
    machine,
    uploader: {
      upload: async (file, options) => {
        const named = name(file.name);
        const upload = await uploadFile(named === file.name ? file : new File([file], named, { type: file.type, lastModified: file.lastModified }), {
          machine,
          signal: options.signal,
          onProgress: options.onProgress,
        }).catch((cause: unknown) => {
          release(named);
          throw cause;
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
  /** In full screen's card: drawn in the row (inside the card's Comment tab), it hands the card's drops to these files. */
  dropTarget: ReactNode;
  /** The finished uploads as the comment's `images` entries. */
  images: () => ImageAttachment[];
  /** Any file still uploading: Comment waits. */
  uploading: boolean;
  /** How many files are uploaded and ready to go with the comment. */
  ready: number;
  /** The finished uploads not on their way in a save, for the row's draft as the file closes. */
  kept: () => InboxUpload[];
  /** Uploads still on their way, for the row's draft as the file closes (they keep going: `late`). */
  flying: () => Promise<InboxUpload | null>[];
  /**
   * What the comment holds as it is kept for later (a phone's pin card as the file closes or steps): the finished
   * uploads and those on their way, which keep going even when the comment is cleared next.
   */
  handOver: () => { files: InboxUpload[]; late: Promise<InboxUpload | null>[] };
  /** A kept comment's files back in it: its finished uploads now, each still on its way as it lands. */
  restore: (files: readonly InboxUpload[], late: readonly Promise<InboxUpload | null>[]) => void;
  /** A save carries these entries: the uploads they name are no draft's while it is on its way. The way back if it fails. */
  sending: (images: readonly ImageAttachment[] | undefined) => () => void;
  /** The comment was saved: its files go with it. */
  clear: () => void;
  /** Files to attach (a drop the card hands over). */
  add: (list: FileList) => void;
}

/** Full screen's card hands its drops on the Comment tab to `add`: drawn inside the tab, where the card's slot is. */
function CommentDropTarget({ add }: { add: (list: FileList) => void }) {
  const slot = useContext(CommentDropContext);
  useEffect(() => (slot ? slot.register(add) : undefined), [slot, add]);
  return null;
}

/**
 * A comment row's files. `initial`: the uploads its draft kept (the file closed and opened again). `phone`: the
 * paperclip's size and its picker (the photo library), as the reply box's. `inCard`: the row is full screen's Comment
 * tab, whose card takes the drop (the row draws `dropTarget`); beside the thread the row is its own drop target.
 * `field`: the row's words field, where focus goes after a tile's × and a pasted text's Put back.
 */
export function useCommentFiles({
  initial,
  late,
  phone = false,
  inCard = false,
  field,
  text,
}: {
  initial?: readonly InboxUpload[] | null;
  /** Uploads still on their way when the row's draft was kept (the file closed mid-upload): each joins the row as it lands. */
  late?: readonly Promise<InboxUpload | null>[] | null;
  phone?: boolean;
  inCard?: boolean;
  field?: () => HTMLTextAreaElement | null;
  /** The row's words: a paste of 32 KB or more becomes the reply box's pasted text tile, put back into them. */
  text?: ComposeFilesText;
}): CommentFiles {
  const host = useContext(CommentFilesContext);
  const on = host !== null;
  /** Uploads on their way, for the row's draft as the file closes: they keep going and land in it. */
  const flying = useRef(new Set<Promise<InboxUpload | null>>());
  const uploader = useMemo<DraftFileUploader | null>(() => {
    if (!host) return null;
    return {
      ...host.uploader,
      upload: (file, options) => {
        const going = host.uploader.upload(file, options);
        const settled = going.then(
          (upload) => upload,
          () => null,
        );
        flying.current.add(settled);
        void settled.finally(() => flying.current.delete(settled));
        return going;
      },
    };
  }, [host]);
  const files = useComposeFiles(initial ?? [], {
    machine: host?.machine ?? null,
    ...(uploader ? { uploader } : {}),
    // As the reply box: a paste is said in a polite live region, and a long one is a pasted text tile.
    onPasted: (names) => announce(attachedAnnouncement(names)),
    ...(text ? { text } : {}),
    // As the reply box: a pasted text put back is said (the caret is after it, in `field`).
    onPutBack: () => announce('The pasted text is back in your reply.'),
    // The row goes (the file closed or stepped) while files upload: they keep going, for its draft (`late`).
    onUnmountUploads: () => {},
  });
  const restoreDraft = files.restoreDraft;
  /** The row is drawn: an upload still on its way joins it as it lands (gone, the row's draft has it: `flying`). */
  const mounted = useRef(true);
  /** Counts hand-overs: an upload handed to a kept comment lands there, not here. */
  const handedOver = useRef(0);
  const join = useCallback(
    (promise: Promise<InboxUpload | null>) => {
      // On its way still: closed again before it lands, the row's draft keeps it again.
      flying.current.add(promise);
      const at = handedOver.current;
      void promise
        .then((upload) => {
          if (mounted.current && at === handedOver.current && upload) restoreDraft([upload], '', 'add');
        })
        .finally(() => flying.current.delete(promise));
    },
    [restoreDraft],
  );
  useEffect(() => {
    mounted.current = true;
    for (const promise of late ?? []) join(promise);
    return () => {
      mounted.current = false;
    };
    // Once, as the row mounts with its draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const attach = useCallback((list: FileList) => (phone ? files.attach(list) : files.add(list)), [files.attach, files.add, phone]);
  const own = useFileDrop((list) => files.add(list), on && !inCard);
  // In full screen's card the drop is the card's: it hands it here.
  const add = useCallback((list: FileList) => void files.add(list), [files.add]);
  const clip = on ? <AttachFilesButton className="ib-fvb ib-cclip" iconSize={phone ? 18 : 15} phone={phone} inputData="data-comment-attach" onFiles={attach} /> : null;
  const tiles =
    files.files.length > 0 ? (
      // Full screen's card: the Reply tab's tile box (`ib-fcomp-files`); beside the thread, the reply box's (`ib-rfiles`).
      <div className={`ib-rfiles ib-cfiles${inCard ? ' ib-fcomp-files' : ''}`} data-comment-files="">
        <ComposeFileTiles
          // A finished tile says the name the agent gets (a second shot.png is stored as shot-2.png).
          files={files.files.map((file) => (file.upload && file.upload.name !== file.name ? { ...file, name: file.upload.name } : file))}
          onPutBack={text ? (key) => void files.putBack(key, field?.() ?? null) : undefined}
          onRemove={(key) => {
            files.remove(key);
            // The × goes with its tile: focus stays in the comment, as in the reply box.
            field?.()?.focus({ preventScroll: true });
          }}
        />
      </div>
    ) : null;
  const current = files.current;
  /** Uploads a save on its way carries (by id). */
  const inSave = useRef(new Set<string>());
  /** The finished uploads not on their way in a save. */
  const kept = () => current().flatMap((file) => (file.state === 'done' && file.upload && !inSave.current.has(file.upload.upload_id) ? [file.upload] : []));
  return {
    on,
    clip,
    tiles,
    onPaste: (event) => {
      if (on) files.paste(event);
    },
    drop:
      on && !inCard
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
    dropTarget: on && inCard ? <CommentDropTarget add={add} /> : null,
    images: () => current().flatMap((file) => (file.state === 'done' && file.upload ? [commentImageOf(file.upload)] : [])),
    uploading: files.uploading,
    ready: files.uploaded.length,
    kept,
    flying: () => [...flying.current],
    handOver: () => {
      const done = kept();
      // Not stopped by the clear that follows: they land in the kept comment.
      files.detach();
      handedOver.current += 1;
      const late = [...flying.current];
      // Theirs now: never handed to the next comment kept here too.
      flying.current.clear();
      return { files: done, late };
    },
    restore: (done, waiting) => {
      if (done.length > 0) restoreDraft(done, '', 'add');
      for (const promise of waiting) join(promise);
    },
    sending: (images) => {
      const ids = (images ?? []).map((image) => image.path.split('/')[0]!).filter((id) => current().some((file) => file.upload?.upload_id === id));
      for (const id of ids) inSave.current.add(id);
      return () => {
        for (const id of ids) inSave.current.delete(id);
      };
    },
    clear: files.reset,
    add,
  };
}
