// Moved from the Workspaces app's `block-parse.ts` with its contents rail
// (MarkdownContentsRail, approved 2026-10-03). Port: none; the module-level
// cache is the same.

import type { Block } from '../types';
import { parseMarkdownToBlocks } from './parser';

/**
 * ONE parse per document body, shared across consumers: a host's Viewer and
 * its contents rail render from the same body string, and each would
 * otherwise run its own full `parseMarkdownToBlocks`. This module-level cache
 * keys on the content string (value equality: the call sites derive `content`
 * independently via `extractFrontmatter`), so whoever parses first feeds
 * everyone.
 *
 * Sharing one blocks array is safe: the consumers treat the parser output as
 * immutable.
 *
 * Capacity 4 with hit-refresh recency: a page holds at most a couple of live
 * bodies at once; the cap only exists so navigating across documents cannot
 * grow it without bound.
 */
const MAX_ENTRIES = 4;
const cache = new Map<string, Block[]>();

/** Test probe: counts real parses (cache misses). */
export const blockParseProbe = { parses: 0 };

export function parseBlocksShared(content: string): Block[] {
  const hit = cache.get(content);
  if (hit !== undefined) {
    // Refresh recency (Map preserves insertion order; oldest is evicted).
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
