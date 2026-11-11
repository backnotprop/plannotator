/**
 * Pictures on the person's comments, as in Annotate (the owner, 2026-11-11:
 * "Match Annotate: turn pictures on"; "Wouldn't pictures just be … added to
 * the messages … as an attachment once you send?").
 *
 * A picture is one of the reply box's own uploads (`POST /api/inbox/uploads`,
 * to the linked machine whose thread it is), named after the picture. The
 * comment keeps it as an `images` entry, `{ path: "<upl id>/<file>", name }`
 * (`inboxCommentPicture`), shown back from `/api/inbox/uploads/<id>/image`.
 * The Send that carries the comment carries its uploads, so each picture is
 * one of the reply's attachments ("Attached: <file> (<path>)"), and the
 * feedback names that file beside the comment, as Annotate's does:
 * "**Attached images:**" then "- [name] `file`". A waiting comment keeps its
 * uploads from the 24-hour sweep; a removed one leaves them to it.
 *
 * The text and the paths are commentPictureFiles.ts (no network: the phone
 * surface reads them too). Only a place under `CommentPictures` offers the picture button: a thread
 * and a review in the window. The tour and the phone app's surface have no
 * uploads, so they offer none.
 */
import { useContext, useMemo, useRef, type ReactNode } from 'react';
import { CommentUploadContext, type UploadTransport } from '@plannotator/ui/utils/upload';
import { uploadFile } from './api';
import { machineOf, rememberMachine } from './inboxUrl';
import type { InboxAnnotationRecord } from '@plannotator/core/inbox-types';
import { pictureFileNames } from './commentPictureFiles';

/**
 * File names this window gave pictures. With the names the thread's waiting comments already hold (`taken`, any
 * window's), two comments' "image-1" go as image-1.png and image-1-2.png: the agent tells them apart by file.
 */
const named = new Set<string>();

function freshName(name: string, taken: readonly string[]): string {
  const used = (candidate: string) => named.has(candidate) || taken.includes(candidate);
  const dot = name.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  let fresh = name;
  for (let n = 2; used(fresh); n++) fresh = `${base}-${n}${ext}`;
  named.add(fresh);
  return fresh;
}

/** The comment boxes' uploads for one thread: to its machine's Inbox, with progress. */
export function commentPictureTransport(machine: string | null, taken: () => readonly string[] = () => []): UploadTransport {
  return {
    upload: async (file, options) => {
      const name = freshName(file.name, taken());
      const upload = await uploadFile(new File([file], name, { type: file.type }), {
        machine,
        onProgress: options?.onProgress,
        signal: options?.signal,
      }).catch((cause: unknown) => {
        // Not uploaded: a Retry gets the same name.
        named.delete(name);
        throw cause;
      });
      if (machine) rememberMachine([upload.upload_id], machine);
      return { path: `${upload.upload_id}/${upload.name}`, originalName: upload.name };
    },
  };
}

/**
 * Comment boxes under this take pictures, uploaded for `thread` (a thread id: its machine is the upload's).
 * `records`: the thread's comments waiting for a Send, whose pictures' file names a new one does not reuse.
 */
export function CommentPictures({ thread, records, children }: { thread: string; records: readonly InboxAnnotationRecord[]; children: ReactNode }) {
  const machine = machineOf(thread);
  const recordsRef = useRef(records);
  recordsRef.current = records;
  const transport = useMemo(() => commentPictureTransport(machine, () => pictureFileNames(recordsRef.current)), [machine]);
  return <CommentUploadContext.Provider value={transport}>{children}</CommentUploadContext.Provider>;
}

/** Whether the comment boxes here can take a picture (a `CommentPictures` is above). */
export function useCommentPictures(): boolean {
  return useContext(CommentUploadContext) !== null;
}
