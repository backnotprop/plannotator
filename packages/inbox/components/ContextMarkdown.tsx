/**
 * An agent's context (a question's, an action item's why) drawn as markdown,
 * read only, with the message's images: lists, bold, code and links as the
 * thread's question cards draw them. One path for decision mode's card and
 * the action item checklist.
 */
import { useMemo } from 'react';
import type { LocalLinkResolver } from '@plannotator/ui/components/LocalLinkContext';
import { Viewer } from '@plannotator/ui/components/Viewer';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { inboxMessageImageBase } from '../images';

const noop = () => {};
const NO_ANNOTATIONS: never[] = [];

export function ContextMarkdown({
  markdown,
  messageId,
  onImage = noop,
  className,
  refRepo = null,
  resolveLocalLink,
  ...data
}: {
  markdown: string;
  /** The message whose images the markdown may show. None: the host's `ImageResolverContext` decides. */
  messageId?: string;
  onImage?: (src: string, alt: string) => void;
  /** The thread's repo, so `#123` and `owner/repo#123` link as in the message (none: `#123` stays plain, `owner/repo#123` links on github.com). */
  refRepo?: { display: string; host?: string } | null;
  /** What a path in the markdown is. None: the renderer's default, which is an address of this window. */
  resolveLocalLink?: LocalLinkResolver;
  /** The wrapper's classes: `ib-body` plus the place's own. */
  className: string;
} & { [attr: `data-${string}`]: string }) {
  const blocks = useMemo(() => parseMarkdownToBlocks(markdown, { frontmatter: false }), [markdown]);
  if (!markdown) return null;
  return (
    <div className={className} {...data}>
      <Viewer
        blocks={blocks}
        markdown={markdown}
        annotations={NO_ANNOTATIONS}
        onAddAnnotation={noop}
        onSelectAnnotation={noop}
        selectedAnnotationId={null}
        mode="selection"
        taterMode={false}
        maxWidth={null}
        stickyActions={false}
        disableCodePathValidation
        refRepo={refRepo}
        resolveLocalLink={resolveLocalLink}
        imageBaseDir={messageId ? inboxMessageImageBase(messageId) : undefined}
        onImageClick={onImage}
        questionDecisionLines={false}
        answerOnly
        readOnly
      />
    </div>
  );
}
