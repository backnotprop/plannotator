/** MessageBody's painted names and links (parts/MessageBody/MessageBody.tsx). */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { InboxAttachmentState } from '@plannotator/core/inbox-types';
import type { LocalLinkResolver } from '@plannotator/ui/components/LocalLinkContext';
import { NOT_ATTACHED_TITLE, attachmentDeepLink, attachmentDisplayPath, attachmentForLink, openAttachmentTitle, projectFileOfLink } from '../../links';
import { resolveReplyLink } from '../../replyFileLinks';
import { OpenInCodeHover } from '../../components/OpenIn';
import { paintSkillReferences } from '../../skillHighlight';
import { paintTagReferences, type TagMarkPlace } from '../../tagHighlight';
import { splitInboxSkillsBlock } from '@plannotator/core/skill-reference-block';
import type { RefObject } from 'react';
import type { MessageBodyProps } from './types';

/** The skills and agents a reply names, painted in its words, and where each link in the body goes. */
export function useBodyLinks({
  message,
  bodyRef,
  skills,
  replyFiles,
  replyFileList,
  projectRoot,
  openInFiles,
  onOpenAttachment,
  setFallback,
}: Pick<MessageBodyProps, 'message' | 'replyFiles' | 'projectRoot' | 'onOpenAttachment'> & {
  openInFiles: boolean;
  bodyRef: RefObject<HTMLDivElement | null>;
  skills: ReturnType<typeof splitInboxSkillsBlock> | null;
  replyFileList: readonly InboxAttachmentState[] | undefined;
  setFallback: (image: { src: string; alt: string }) => void;
}) {
  // The skills the block names are painted in the person's words, as the composer painted them.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !skills) return;
    return paintSkillReferences(message.id, body, skills.skills);
  }, [message.id, skills]);
  // The agents the reply tags are painted too (approval "inbox-tag-agents"), from the labels it carries.
  const sentTags = message.author.kind === 'person' ? (message.tags ?? []) : [];
  const tagLabels = sentTags.map((t) => t.label ?? '').filter(Boolean).join('\u0000');
  // Each token's chip carries its agent's mark over the `@` (the approved shot 5), drawn in a layer of our own.
  const tagHosts = new Map(sentTags.filter((t) => t.label).map((t) => [t.label!, t.host]));
  const tagLayerRef = useRef<HTMLDivElement>(null);
  const [tagMarks, setTagMarks] = useState<TagMarkPlace[]>([]);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !tagLabels) return;
    return paintTagReferences(`${message.id}:tags`, body, tagLabels.split('\u0000'), {
      layer: tagLayerRef.current,
      onMarks: (next) => setTagMarks((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next)),
    });
  }, [message.id, tagLabels]);
  // A link to a file this message attached opens it beside the thread; any
  // other local link is inert text (links.ts). Kept stable across renders,
  // so raw-HTML blocks do not redraw their links on every pick.
  const openRef = useRef(onOpenAttachment);
  openRef.current = onOpenAttachment;
  const openReplyFileRef = useRef(replyFiles?.onOpen);
  openReplyFileRef.current = replyFiles?.onOpen;
  const resolveLocalLink = useCallback<LocalLinkResolver>(
    (href) => {
      // A file the person's reply commented on (its feedback heading), or a drawing it carried.
      const replyLink = replyFileList ? resolveReplyLink(href, replyFileList) : null;
      if (replyLink?.kind === 'file') {
        const { attachment: file, version } = replyLink;
        const path = attachmentDisplayPath(file, projectRoot);
        return {
          kind: 'open',
          title: version === 'sent' ? `Open the sent version of ${path} beside the thread` : openAttachmentTitle(path),
          href: attachmentDeepLink(message.thread_id, file.id, version),
          open: () => openReplyFileRef.current?.(file, version),
        };
      }
      if (replyLink?.kind === 'markup') {
        const src = replyLink.src;
        return { kind: 'open', title: 'Show the drawing', href: src, open: () => setFallback({ src, alt: 'Your drawing' }) };
      }
      const attachment = attachmentForLink(href, { attachments: message.attachments ?? [], root: projectRoot, base: message.base_path ?? null });
      if (!attachment) {
        // Not attached, but a file of the project: its code on hover, with Open in (nothing when there is no such file).
        const projectFile = openInFiles ? projectFileOfLink(href) : null;
        return {
          kind: 'unavailable',
          title: NOT_ATTACHED_TITLE,
          ...(projectFile
            ? {
                wrap: (text: ReactNode) => (
                  <OpenInCodeHover scope={{ thread: message.thread_id, message: message.id }} path={projectFile.path} line={projectFile.line} lineEnd={projectFile.lineEnd} title={NOT_ATTACHED_TITLE}>
                    {text}
                  </OpenInCodeHover>
                ),
              }
            : {}),
        };
      }
      return {
        kind: 'open',
        title: openAttachmentTitle(attachmentDisplayPath(attachment, projectRoot)),
        href: attachmentDeepLink(message.thread_id, attachment.id),
        open: () => openRef.current(attachment),
      };
    },
    [message.attachments, message.base_path, message.thread_id, message.id, projectRoot, replyFileList, openInFiles],
  );
  return { tagLabels, tagHosts, tagLayerRef, tagMarks, resolveLocalLink };
}
