import React from 'react';
import { renderProseBody } from './proseBody';

interface CalloutProps {
  blockId: string;
  kind: string;
  body: string;
  containerClassName: string;
  blockType: 'alert' | 'directive';
  kindAttribute: string;
  onOpenLinkedDoc?: (path: string) => void;
  imageBaseDir?: string;
  onImageClick?: (src: string, alt: string) => void;
  githubRepo?: string;
  onNavigateAnchor?: (hash: string) => void;
}

export const Callout: React.FC<CalloutProps> = ({
  blockId,
  kind,
  body,
  containerClassName,
  blockType,
  kindAttribute,
  onOpenLinkedDoc,
  imageBaseDir,
  onImageClick,
  githubRepo,
  onNavigateAnchor,
}) => {
  const kindAttr =
    blockType === 'alert' ? { 'data-alert-kind': kindAttribute } : { 'data-directive-kind': kindAttribute };
  return (
    <div
      className={containerClassName}
      data-block-id={blockId}
      data-block-type={blockType}
      {...kindAttr}
    >
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
        onNavigateAnchor,
        githubRepo,
      })}
    </div>
  );
};
