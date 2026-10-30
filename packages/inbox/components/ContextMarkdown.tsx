/**
 * An agent's context (a question's, an action item's why) drawn as markdown,
 * read only, with the message's images: lists, bold, code and links as the
 * thread's question cards draw them. One path for decision mode's card and
 * the action item checklist.
 */
import { useMemo } from 'react';
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
  ...data
}: {
  markdown: string;
  messageId: string;
  onImage?: (src: string, alt: string) => void;
  /** The thread's repo, so `#123` and `owner/repo#123` link as in the message (none: they stay plain). */
  refRepo?: { display: string; host?: string } | null;
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
        imageBaseDir={inboxMessageImageBase(messageId)}
        onImageClick={onImage}
        questionDecisionLines={false}
        answerOnly
        readOnly
      />
    </div>
  );
}
