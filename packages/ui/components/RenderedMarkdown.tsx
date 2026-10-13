import React, { useMemo } from 'react';
import { parseMarkdownToBlocks, groupBlocks, computeListIndices } from '../utils/parser';
import { BlockRenderer } from './BlockRenderer';
import { LocalLinkContext, type LocalLinkResolver } from './LocalLinkContext';
import { ImageResolverContext, type ImageResolver } from './ImageResolverContext';
import { buildHeadingSlugMap } from '../utils/slugify';

/**
 * Full markdown renderer for surfaces outside the plan editor (e.g. the PR
 * description). Reuses the shared {@link BlockRenderer} — so tables, HTML,
 * callouts, code, and `data-block-id` all come along — without dragging in the
 * plan Viewer's diagram/toolbar/lightbox machinery.
 *
 * Sizing/spacing is inherited from the wrapper: pass `className="md-compact"`
 * (or any scope) to override the renderer's plan-sized defaults via CSS.
 */
export interface RenderedMarkdownProps {
  markdown: string;
  className?: string;
  onImageClick?: (src: string, alt: string) => void;
  onOpenLinkedDoc?: (path: string) => void;
  onOpenCodeFile?: (path: string) => void;
  githubRepo?: string;
  repoHost?: string;
  /**
   * Optional: decides what a link to a local path does (open it in the host,
   * or render it inert). Same contract as Viewer's `resolveLocalLink`.
   * Absent, links render exactly as before.
   */
  resolveLocalLink?: LocalLinkResolver;
  /**
   * Optional: decides where an image loads from, or that it is not shown.
   * Absent, images resolve exactly as before.
   */
  resolveImage?: ImageResolver;
  /**
   * Optional: give headings slug ids (Viewer's slugger, GitHub dedup), so a
   * host can scroll to `#section` links. Absent/false, headings carry no id.
   */
  headingAnchors?: boolean;
}

export const RenderedMarkdown: React.FC<RenderedMarkdownProps> = ({
  markdown,
  className,
  onImageClick,
  onOpenLinkedDoc,
  onOpenCodeFile,
  githubRepo,
  repoHost,
  resolveLocalLink,
  resolveImage,
  headingAnchors = false,
}) => {
  const blocks = useMemo(() => parseMarkdownToBlocks(markdown), [markdown]);
  const groups = useMemo(() => groupBlocks(blocks), [blocks]);
  const headingSlugMap = useMemo(
    () => (headingAnchors ? buildHeadingSlugMap(blocks) : null),
    [blocks, headingAnchors],
  );
  const cb = { onImageClick, onOpenLinkedDoc, onOpenCodeFile, githubRepo, repoHost };

  let body = (
    <div className={className}>
      {groups.map((group) =>
        group.type === 'list-group' ? (
          (() => {
            const indices = computeListIndices(group.blocks);
            return (
              <div key={group.key}>
                {group.blocks.map((block, i) => (
                  <BlockRenderer key={block.id} block={block} orderedIndex={indices[i]} headingAnchorId={headingSlugMap?.get(block.id)} {...cb} />
                ))}
              </div>
            );
          })()
        ) : (
          <BlockRenderer key={group.block.id} block={group.block} headingAnchorId={headingSlugMap?.get(group.block.id)} {...cb} />
        ),
      )}
    </div>
  );
  // Provide only what the caller passed, so an enclosing provider still
  // applies when a prop is absent.
  if (resolveImage) {
    body = <ImageResolverContext.Provider value={resolveImage}>{body}</ImageResolverContext.Provider>;
  }
  if (resolveLocalLink) {
    body = <LocalLinkContext.Provider value={resolveLocalLink}>{body}</LocalLinkContext.Provider>;
  }
  return body;
};
