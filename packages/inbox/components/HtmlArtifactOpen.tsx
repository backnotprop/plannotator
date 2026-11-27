/**
 * A thread's html block opened big from the Artifacts grid or the Artifacts wall (htmlArtifactOpen.ts; the owner,
 * 2026-11-25: "Clicking it in Artifacts opens that same live block, big ... with the same annotate tools"). Drawn by
 * the thread (Thread.tsx), whatever its view: the grid, or its messages when the Wall opened it.
 *
 * The same block as in the message: ui's `HtmlEmbedBlock` on the block the message's text parses to (the same
 * source, its place among the message's html blocks, its fence's lines), with `open` (Full screen's popout, the
 * page whole, Code and the pen in its title bar). Its comments are the message's own, saved where a comment made
 * under the block in the text is saved, so either one shows them. Its page is served as the block's in the text is
 * (it may load from the web); a block is never saved as a file.
 */

import { useEffect, useMemo, useState } from 'react';
import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import { inboxHtmlBlocksOf } from '@plannotator/core/inbox-artifact-pins';
import { inboxHtmlBlockHash, readInboxHtmlArtifactKey } from '@plannotator/core/inbox-html-blocks';
import { HtmlEmbedBlock, type HtmlEmbedHost, type HtmlEmbedOpen } from '@plannotator/ui/components/html-embed/HtmlEmbedBlock';
import { isHtmlEmbedLanguage } from '@plannotator/ui/components/html-embed/languages';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import type { Annotation, Block } from '@plannotator/ui/types';
import { inboxEmbedPageUrl, inboxEmbedUrl } from '../data/actions/embed';
import { agentName } from '../format';
import { useCommentPictures } from '../commentPictures';
import { closeHtmlArtifact, dropHtmlArtifact, useHtmlArtifactOpen } from '../htmlArtifactOpen';
import type { MessageActsRef } from '../parts/messageActs';

const OPEN: HtmlEmbedOpen = { onClose: closeHtmlArtifact };

/**
 * The message's block with this hash, as its text draws it: the parsed block and its place among the text's html
 * blocks (the place a comment anchors to; 0 when the text does not draw it as one, so it takes no comment here).
 */
export function htmlArtifactBlock(message: Pick<InboxMessageWire, 'id' | 'body' | 'author'>, hash: string): { block: Block; index: number } | null {
  const drawn = parseMarkdownToBlocks(message.body, { frontmatter: false }).filter((block) => block.type === 'code' && isHtmlEmbedLanguage(block.language));
  const at = drawn.findIndex((block) => inboxHtmlBlockHash(block.content) === hash);
  if (at >= 0) return { block: drawn[at]!, index: at + 1 };
  const listed = inboxHtmlBlocksOf(message).find((block) => block.hash === hash);
  return listed ? { block: { id: `html-artifact-${hash}`, type: 'code', language: 'html', content: listed.content, order: 0, startLine: listed.startLine }, index: 0 } : null;
}

export function HtmlArtifactOpen({
  threadId,
  messages,
  commentsOf,
  acts,
}: {
  threadId: string;
  messages: readonly InboxMessageWire[];
  /** The message's comments waiting for a Send, or null when its text takes none (as its own block's). */
  commentsOf: (message: InboxMessageWire) => readonly Annotation[] | null;
  acts: MessageActsRef;
}) {
  const request = useHtmlArtifactOpen(threadId);
  // The thread left the screen (a Back, another thread): its request goes with it.
  useEffect(() => () => dropHtmlArtifact(threadId), [threadId]);
  const named = request ? readInboxHtmlArtifactKey(request.key) : null;
  const message = named ? (messages.find((m) => m.id === named.messageId) ?? null) : null;
  const hash = named?.hash ?? null;
  const found = useMemo(() => (message && hash ? htmlArtifactBlock(message, hash) : null), [message, hash]);
  // A block that is not in the thread (any more): nothing opens, and nothing waits to.
  const missing = request !== null && messages.length > 0 && found === null;
  useEffect(() => {
    if (missing) dropHtmlArtifact(threadId);
  }, [missing, threadId]);
  if (!request || !message || !found) return null;
  return <OpenBlock key={request.key} message={message} block={found.block} index={found.index} comments={commentsOf(message)} acts={acts} />;
}

function OpenBlock({ message, block, index, comments, acts }: { message: InboxMessageWire; block: Block; index: number; comments: readonly Annotation[] | null; acts: MessageActsRef }) {
  const pictures = useCommentPictures();
  // A marker's press shows its comment selected here (the comment list is under the popout).
  const [selected, setSelected] = useState<string | null>(null);
  const author = message.author.kind === 'agent' ? agentName(message.author) : undefined;
  const annotations = useMemo(() => (comments ?? []).filter((comment) => comment.htmlBlockAnchor != null), [comments]);
  const takes = comments !== null && index > 0;
  const host = useMemo<HtmlEmbedHost>(
    () => ({
      frameUrl: inboxEmbedUrl,
      author,
      annotate: takes
        ? {
            frameUrl: inboxEmbedPageUrl,
            indexOf: (b) => (b.id === block.id ? index : 0),
            annotations,
            onAdd: (annotation) => acts.current.saveMessageComment(message.id, annotation),
            selectedId: selected,
            onSelect: setSelected,
            onRestoreReport: (report) => acts.current.noteUnanchored(report),
            allowImages: pictures,
          }
        : undefined,
    }),
    [author, takes, block.id, index, annotations, acts, message.id, selected, pictures],
  );
  return <HtmlEmbedBlock block={block} host={host} open={OPEN} />;
}
