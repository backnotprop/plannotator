/**
 * A file an agent's message names opens beside the thread (approval "inbox-file-refs-open-viewer"): a link that is
 * not attached, a code span that is a path, a bare path, a picture that did not load. The person's own words keep
 * their links as they are.
 */
import { useRef } from 'react';
import type { FileRef } from '../../fileRefs';
import { attachmentForLink } from '../../links';
import type { MessageBodyProps } from './types';

export type OpenFileRefRef = { current: ((ref: FileRef) => void) | undefined };

export function useFileRefs({ message, projectRoot, onOpenFileRef, onOpenAttachment }: Pick<MessageBodyProps, 'message' | 'projectRoot' | 'onOpenFileRef' | 'onOpenAttachment'>) {
  const refsOn = !!onOpenFileRef && message.author.kind === 'agent';
  // The host's callbacks, read through refs: named in a closure React keeps, they would pin the thread view of a read.
  const hostRef = useRef(onOpenFileRef);
  hostRef.current = onOpenFileRef;
  const attachmentRef = useRef(onOpenAttachment);
  attachmentRef.current = onOpenAttachment;
  const openFileRefRef = useRef<((ref: FileRef) => void) | undefined>(undefined);
  // A file the message carries opens as that attachment (comments and all); any other file read only.
  openFileRefRef.current = refsOn
    ? (ref) => {
        const attached = attachmentForLink(ref.path, { attachments: message.attachments ?? [], root: projectRoot, base: message.base_path ?? null });
        if (attached) attachmentRef.current(attached);
        else hostRef.current?.(ref);
      }
    : undefined;
  return { refsOn, openFileRefRef: openFileRefRef as OpenFileRefRef };
}
