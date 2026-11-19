/**
 * The plan, drawn by the product's own parser and block renderer
 * (`@plannotator/ui`), with snapshot blocks drawn through the
 * `directiveRenderer` seam. Nothing here is a second Markdown renderer.
 */
import { BlockRenderer } from '@plannotator/ui/components/BlockRenderer';
import type { Block } from '@plannotator/ui/types';
import { computeListIndices, groupBlocks } from '@plannotator/ui/utils/parser';
import React, { forwardRef } from 'react';

export const PlanPane = forwardRef<HTMLDivElement, { blocks: Block[]; arrived: string | null }>(function PlanPane({ blocks, arrived }, ref) {
  return (
    <div ref={ref} className="demo-plan" data-pcv-plan-drop>
      <article>
        {groupBlocks(blocks).map((group) => {
          if (group.type === 'list-group') {
            const indices = computeListIndices(group.blocks);
            return (
              <div key={group.key} data-pinpoint-group="list">
                {group.blocks.map((block, i) => (
                  <BlockRenderer key={block.id} block={block} orderedIndex={indices[i]} />
                ))}
              </div>
            );
          }
          return (
            <div key={group.block.id} className={group.block.id === arrived ? 'demo-new' : undefined}>
              <BlockRenderer block={group.block} />
            </div>
          );
        })}
      </article>
    </div>
  );
});
