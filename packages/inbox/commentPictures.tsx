import { useContext, useMemo, useRef, type ReactNode } from 'react';
import { CommentUploadContext, type UploadTransport } from '@plannotator/ui/utils/upload';
import { CommentCardToolsContext } from '@plannotator/ui/components/CommentCardTools';
import { CardVoice } from './components/CardVoice';
import { CommentDraftHostContext } from '@plannotator/ui/components/CommentDraftHost';
import { commentDraftHost } from './commentDraftHost';
import { uploadFile } from './api';
import { machineOf, rememberMachine } from './inboxUrl';
import type { InboxAnnotationRecord } from '@plannotator/core/inbox-types';
import { pictureFileNames } from './commentPictureFiles';

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

export function commentPictureTransport(machine: string | null, taken: () => readonly string[] = () => []): UploadTransport {
  return {
    files: true,
    upload: async (file, options) => {
      const name = freshName(file.name, taken());
      const upload = await uploadFile(new File([file], name, { type: file.type }), {
        machine,
        onProgress: options?.onProgress,
        signal: options?.signal,
      }).catch((cause: unknown) => {
        named.delete(name);
        throw cause;
      });
      if (machine) rememberMachine([upload.upload_id], machine);
      return { path: `${upload.upload_id}/${upload.name}`, originalName: upload.name };
    },
  };
}

export function CommentPictures({ thread, records, children }: { thread: string; records: readonly InboxAnnotationRecord[]; children: ReactNode }) {
  const machine = machineOf(thread);
  const recordsRef = useRef(records);
  recordsRef.current = records;
  const transport = useMemo(() => commentPictureTransport(machine, () => pictureFileNames(recordsRef.current)), [machine]);
  const drafts = useMemo(() => (machine ? null : commentDraftHost(thread)), [machine, thread]);
  return (
    <CommentUploadContext.Provider value={transport}>
      <CommentCardToolsContext.Provider value={CardVoice}>
        <CommentDraftHostContext.Provider value={drafts}>{children}</CommentDraftHostContext.Provider>
      </CommentCardToolsContext.Provider>
    </CommentUploadContext.Provider>
  );
}

export function useCommentPictures(): boolean {
  return useContext(CommentUploadContext) !== null;
}
