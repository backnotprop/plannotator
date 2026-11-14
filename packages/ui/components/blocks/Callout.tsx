import React from 'react';
import type { Block } from '../../types';
import { SourceLineGutter } from '../SourceLineGutter';
import { renderProseBody } from './proseBody';

interface CalloutProps {
  blockId: string;
  sourceBlock?: Block;
  kind: string;
  body: string;
  containerClassName: string;
  blockType: 'alert' | 'directive';
  kindAttribute: string;
  onOpenLinkedDoc?: (path: string) => void;
  onOpenCodeFile?: (path: string) => void;
  imageBaseDir?: string;
  onImageClick?: (src: string, alt: string) => void;
  githubRepo?: string;
  repoHost?: string;
  onNavigateAnchor?: (hash: string) => void;
}

export const Callout: React.FC<CalloutProps> = ({
  blockId,
  sourceBlock,
  kind,
  body,
  containerClassName,
  blockType,
  kindAttribute,
  onOpenLinkedDoc,
  onOpenCodeFile,
  imageBaseDir,
  onImageClick,
  githubRepo,
  repoHost,
  onNavigateAnchor,
}) => {
  const kindAttr =
    blockType === 'alert' ? { 'data-alert-kind': kindAttribute } : { 'data-directive-kind': kindAttribute };
  return (
    <div
      className={`${containerClassName} relative`}
      data-block-id={blockId}
      data-block-type={blockType}
      {...kindAttr}
    >
      <SourceLineGutter block={sourceBlock} />
      <div className={`${blockType}-title text-xs font-semibold uppercase tracking-wide mb-1`}>
        {kind}
      </div>
      {renderProseBody({
        body,
        // Callout inherits text color from the container (directive tint per
        // kind). Only pass size/leading classes, not a text-foreground value.
        paragraphClassName: 'text-[15px] leading-relaxed',
        listClassName: 'text-[15px] leading-relaxed',
        imageBaseDir,
        onImageClick,
        onOpenLinkedDoc,
        onOpenCodeFile,
        onNavigateAnchor,
        githubRepo,
        repoHost,
      })}
    </div>
  );
};
