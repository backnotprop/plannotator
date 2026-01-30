/**
 * Plan Diff Algorithm
 *
 * Block-level comparison using LCS (Longest Common Subsequence).
 * Compares plans at the block level for cleaner, more readable diffs.
 */

import { Block } from './types';

export type DiffType = 'unchanged' | 'added' | 'removed' | 'modified';

/**
 * Simple hash function (djb2) - browser compatible.
 */
function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

export interface BlockDiff {
  type: DiffType;
  oldBlock?: Block;
  newBlock?: Block;
  /** Similarity score 0-1 for modified blocks */
  similarity?: number;
}

/**
 * Compute a hash for block comparison.
 * Uses type + content for matching.
 */
function blockHash(block: Block): string {
  const key = `${block.type}:${block.content}`;
  return simpleHash(key);
}

/**
 * Calculate similarity between two strings (0-1).
 * Uses Levenshtein distance normalized by max length.
 */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const maxLen = Math.max(a.length, b.length);
  const distance = levenshteinDistance(a, b);
  return 1 - distance / maxLen;
}

/**
 * Levenshtein distance between two strings.
 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Use two rows for space optimization
  let prev = new Array(n + 1).fill(0);
  let curr = new Array(n + 1).fill(0);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1];
      } else {
        curr[j] = 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
      }
    }
    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

/**
 * LCS (Longest Common Subsequence) of block hashes.
 * Returns indices of matching blocks.
 */
function lcsBlockIndices(
  oldBlocks: Block[],
  newBlocks: Block[]
): { oldIdx: number; newIdx: number }[] {
  const oldHashes = oldBlocks.map(blockHash);
  const newHashes = newBlocks.map(blockHash);

  const m = oldHashes.length;
  const n = newHashes.length;

  // Build LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0)
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldHashes[i - 1] === newHashes[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find LCS indices
  const matches: { oldIdx: number; newIdx: number }[] = [];
  let i = m;
  let j = n;

  while (i > 0 && j > 0) {
    if (oldHashes[i - 1] === newHashes[j - 1]) {
      matches.unshift({ oldIdx: i - 1, newIdx: j - 1 });
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return matches;
}

/**
 * Find the best match for a removed block among added blocks.
 * Returns the index and similarity score, or null if no good match.
 */
function findBestMatch(
  removedBlock: Block,
  addedBlocks: Block[],
  usedIndices: Set<number>,
  threshold: number = 0.5
): { index: number; similarity: number } | null {
  let bestIndex = -1;
  let bestSimilarity = 0;

  for (let i = 0; i < addedBlocks.length; i++) {
    if (usedIndices.has(i)) continue;

    const addedBlock = addedBlocks[i];
    // Only compare same-type blocks
    if (removedBlock.type !== addedBlock.type) continue;

    const sim = similarity(removedBlock.content, addedBlock.content);
    if (sim > bestSimilarity && sim >= threshold) {
      bestSimilarity = sim;
      bestIndex = i;
    }
  }

  if (bestIndex === -1) return null;
  return { index: bestIndex, similarity: bestSimilarity };
}

/**
 * Compute block-level diff between two sets of blocks.
 *
 * Algorithm:
 * 1. Find LCS of unchanged blocks
 * 2. Mark non-LCS old blocks as removed
 * 3. Mark non-LCS new blocks as added
 * 4. Try to match removed/added pairs as "modified" if similarity > threshold
 */
export function diffBlocks(
  oldBlocks: Block[],
  newBlocks: Block[],
  modifyThreshold: number = 0.5
): BlockDiff[] {
  const lcsMatches = lcsBlockIndices(oldBlocks, newBlocks);

  // Track which indices are in the LCS
  const oldInLCS = new Set(lcsMatches.map(m => m.oldIdx));
  const newInLCS = new Set(lcsMatches.map(m => m.newIdx));

  // Collect removed and added blocks
  const removed: { block: Block; idx: number }[] = [];
  const added: { block: Block; idx: number }[] = [];

  for (let i = 0; i < oldBlocks.length; i++) {
    if (!oldInLCS.has(i)) {
      removed.push({ block: oldBlocks[i], idx: i });
    }
  }

  for (let i = 0; i < newBlocks.length; i++) {
    if (!newInLCS.has(i)) {
      added.push({ block: newBlocks[i], idx: i });
    }
  }

  // Try to match removed blocks with added blocks as "modified"
  const modifiedPairs: {
    oldBlock: Block;
    newBlock: Block;
    similarity: number;
    oldIdx: number;
    newIdx: number;
  }[] = [];
  const usedAddedIndices = new Set<number>();
  const matchedRemovedIndices = new Set<number>();

  for (const { block: removedBlock, idx: removedIdx } of removed) {
    const addedBlocksWithIdx = added.map(a => a.block);
    const match = findBestMatch(
      removedBlock,
      addedBlocksWithIdx,
      usedAddedIndices,
      modifyThreshold
    );

    if (match) {
      const addedEntry = added[match.index];
      usedAddedIndices.add(match.index);
      matchedRemovedIndices.add(removedIdx);
      modifiedPairs.push({
        oldBlock: removedBlock,
        newBlock: addedEntry.block,
        similarity: match.similarity,
        oldIdx: removedIdx,
        newIdx: addedEntry.idx,
      });
    }
  }

  // Build the final diff result
  // We'll interleave based on block order in new version
  const result: BlockDiff[] = [];

  // Create a map for quick lookup
  const oldIdxToLcsNew = new Map<number, number>();
  for (const m of lcsMatches) {
    oldIdxToLcsNew.set(m.oldIdx, m.newIdx);
  }

  const modifiedByNewIdx = new Map<number, typeof modifiedPairs[0]>();
  for (const mp of modifiedPairs) {
    modifiedByNewIdx.set(mp.newIdx, mp);
  }

  const addedByNewIdx = new Map<number, Block>();
  for (let i = 0; i < added.length; i++) {
    const entry = added[i];
    if (!usedAddedIndices.has(i)) {
      addedByNewIdx.set(entry.idx, entry.block);
    }
  }

  // First, add removed blocks that weren't matched
  for (const { block, idx } of removed) {
    if (!matchedRemovedIndices.has(idx)) {
      result.push({
        type: 'removed',
        oldBlock: block,
      });
    }
  }

  // Then process new blocks in order
  for (let newIdx = 0; newIdx < newBlocks.length; newIdx++) {
    const newBlock = newBlocks[newIdx];

    // Check if this is an unchanged block (in LCS)
    if (newInLCS.has(newIdx)) {
      const lcsMatch = lcsMatches.find(m => m.newIdx === newIdx);
      if (lcsMatch) {
        result.push({
          type: 'unchanged',
          oldBlock: oldBlocks[lcsMatch.oldIdx],
          newBlock: newBlock,
        });
      }
      continue;
    }

    // Check if this is a modified block
    if (modifiedByNewIdx.has(newIdx)) {
      const mp = modifiedByNewIdx.get(newIdx)!;
      result.push({
        type: 'modified',
        oldBlock: mp.oldBlock,
        newBlock: mp.newBlock,
        similarity: mp.similarity,
      });
      continue;
    }

    // Otherwise it's an added block
    if (addedByNewIdx.has(newIdx)) {
      result.push({
        type: 'added',
        newBlock: newBlock,
      });
    }
  }

  return result;
}

/**
 * Generate a summary of the diff.
 */
export function diffSummary(diffs: BlockDiff[]): {
  unchanged: number;
  added: number;
  removed: number;
  modified: number;
} {
  return {
    unchanged: diffs.filter(d => d.type === 'unchanged').length,
    added: diffs.filter(d => d.type === 'added').length,
    removed: diffs.filter(d => d.type === 'removed').length,
    modified: diffs.filter(d => d.type === 'modified').length,
  };
}
