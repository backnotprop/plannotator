import type { Block, Annotation } from '../types';

/**
 * Calculate annotation counts per section (grouped by headings) A section includes all blocks
 * from a heading until the next heading of same/higher level
 */
export function getAnnotationCountBySection(
  blocks: Block[],
  annotations: Annotation[]
): Map<string, number> {
  const counts = new Map<string, number>();
  
  const headings = blocks.filter(b => b.type === 'heading' && (b.level ?? 0) <= 3);
  
  if (headings.length === 0) return counts;
  
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const currentLevel = heading.level ?? 1;
    const startLine = heading.startLine;
    
    let endLine = Infinity;
    for (let j = i + 1; j < headings.length; j++) {
      const nextHeading = headings[j];
      const nextLevel = nextHeading.level ?? 1;
      if (nextLevel <= currentLevel) {
        endLine = nextHeading.startLine;
        break;
      }
    }
    
    let count = 0;
    for (const block of blocks) {
      if (block.startLine >= startLine && block.startLine < endLine) {
        const blockAnnotations = annotations.filter(a => a.blockId === block.id);
        count += blockAnnotations.length;
      }
    }
    
    counts.set(heading.id, count);
  }
  
  return counts;
}

/** Build hierarchical TOC structure from flat blocks array */
export interface TocItem {
  id: string;
  content: string;
  level: number;
  order: number;
  children: TocItem[];
  annotationCount: number;
}

/**
 * The headings a Contents list shows, in document order: levels 1 to `maxLevel` (3 by default,
 * plan review's list).
 */
export function tocHeadings(blocks: readonly Block[], maxLevel = 3): Block[] {
  return blocks
    .filter(b => b.type === 'heading' && (b.level ?? 0) <= maxLevel)
    .sort((a, b) => a.order - b.order);
}

export const CONTENTS_RAIL_MAX_LEVEL = 4;
/** The contents rail shows for a document with at least this many of them. */
export const CONTENTS_RAIL_MIN_HEADINGS = 4;
/** The contents rail shows in a scroll element at least this wide (and with a 68 px gutter). */
export const CONTENTS_RAIL_MIN_PANE_WIDTH = 480;

/** Kept out of the rail's own module, so a host can decide without loading the (lazy) rail. */
export function hasContentsRailHeadings(blocks: readonly Block[]): boolean {
  return tocHeadings(blocks, CONTENTS_RAIL_MAX_LEVEL).length >= CONTENTS_RAIL_MIN_HEADINGS;
}

export function buildTocHierarchy(
  blocks: Block[],
  annotationCounts: Map<string, number>,
  maxLevel = 3
): TocItem[] {
  const headings = tocHeadings(blocks, maxLevel);
  
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
    
    while (stack.length > 0 && stack[stack.length - 1].level >= item.level) {
      stack.pop();
    }
    
    if (stack.length === 0) {
      root.push(item);
    } else {
      stack[stack.length - 1].children.push(item);
    }
    
    stack.push(item);
  }
  
  return root;
}
