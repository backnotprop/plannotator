import type { Block } from '../types';
import { parseMarkdownToBlocks } from './parser';

const MAX_ENTRIES = 4;
const cache = new Map<string, Block[]>();

/** Test probe: counts real parses (cache misses). */
export const blockParseProbe = { parses: 0 };

export function parseBlocksShared(content: string): Block[] {
  const hit = cache.get(content);
  if (hit !== undefined) {
    cache.delete(content);
    cache.set(content, hit);
    return hit;
  }
  blockParseProbe.parses += 1;
  const blocks = parseMarkdownToBlocks(content);
  cache.set(content, blocks);
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return blocks;
}
