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
  messageId?: string;
  onImage?: (src: string, alt: string) => void;
  refRepo?: { display: string; host?: string } | null;
  resolveLocalLink?: LocalLinkResolver;
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
