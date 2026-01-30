import type { Block, Annotation } from '../types';

/**
 * Calculate annotation counts per section (grouped by headings)
 * A section includes all blocks from a heading until the next heading of same/higher level
 */
export function getAnnotationCountBySection(
  blocks: Block[],
  annotations: Annotation[]
): Map<string, number> {
  const counts = new Map<string, number>();
  
  // Find all headings
  const headings = blocks.filter(b => b.type === 'heading' && (b.level ?? 0) <= 3);
  
  if (headings.length === 0) return counts;
  
  // For each heading, determine which blocks belong to its section
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const currentLevel = heading.level ?? 1;
    const startLine = heading.startLine;
    
    // Find the end of this section (next heading of same/higher level)
    let endLine = Infinity;
    for (let j = i + 1; j < headings.length; j++) {
      const nextHeading = headings[j];
      const nextLevel = nextHeading.level ?? 1;
      if (nextLevel <= currentLevel) {
        endLine = nextHeading.startLine;
        break;
      }
    }
    
    // Count annotations in blocks within this section
    let count = 0;
    for (const block of blocks) {
      if (block.startLine >= startLine && block.startLine < endLine) {
        // Count annotations that belong to this block
        const blockAnnotations = annotations.filter(a => a.blockId === block.id);
        count += blockAnnotations.length;
      }
    }
    
    counts.set(heading.id, count);
  }
  
  return counts;
}

/**
 * Build hierarchical TOC structure from flat blocks array
 */
export interface TocItem {
  id: string;
  content: string;
  level: number;
  order: number;
  children: TocItem[];
  annotationCount: number;
}

export function buildTocHierarchy(
  blocks: Block[],
  annotationCounts: Map<string, number>
): TocItem[] {
  const headings = blocks
    .filter(b => b.type === 'heading' && (b.level ?? 0) <= 3)
    .sort((a, b) => a.order - b.order);
  
  const root: TocItem[] = [];
  const stack: TocItem[] = [];
  
  for (const heading of headings) {
    const item: TocItem = {
      id: heading.id,
      content: heading.content,
      level: heading.level ?? 1,
      order: heading.order,
      children: [],
      annotationCount: annotationCounts.get(heading.id) ?? 0,
    };
    
    // Find the correct parent based on level
    while (stack.length > 0 && stack[stack.length - 1].level >= item.level) {
      stack.pop();
    }
    
    if (stack.length === 0) {
      // Top-level item
      root.push(item);
    } else {
      // Child of the last item in stack
      stack[stack.length - 1].children.push(item);
    }
    
    stack.push(item);
  }
  
  return root;
}
