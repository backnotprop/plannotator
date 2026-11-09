import { useMemo } from 'react';
import type { CallFlowNode } from '@plannotator/shared/call-flow-types';
import type { ReviewState } from '../dock/ReviewStateContext';
import {
  createReviewFileSourceLoader,
  useReviewFileSource,
  type ReviewFileSource,
  type ReviewFileSourceLoader,
  type ReviewFileSourceOptions,
} from './useReviewFileSource';

/** The source a Call Flow location's hover preview shows: the side of the file the node lives on. */
export type CallFlowNodeSource = ReviewFileSource;

export type CallFlowNodeSourceLoader = (node: CallFlowNode) => Promise<CallFlowNodeSource | null>;

/** Read a Call Flow step's file through a review file loader: the old side for a removed step. */
export function callFlowNodeSourceLoader(load: ReviewFileSourceLoader): CallFlowNodeSourceLoader {
  return async (node) => {
    if (!node.file || !node.line) return null;
    return load(node.file, node.status === 'removed' ? 'old' : 'new');
  };
}

/** A Call Flow loader over its own file loader (`createReviewFileSourceLoader`). */
export function createCallFlowNodeSourceLoader(options: ReviewFileSourceOptions): CallFlowNodeSourceLoader {
  return callFlowNodeSourceLoader(createReviewFileSourceLoader(options));
}

/** The Call Flow hover loader for the current review, or undefined when the review has no full file contents. */
export function useCallFlowNodeSource(state: ReviewState | null): CallFlowNodeSourceLoader | undefined {
  const load = useReviewFileSource(state);
  return useMemo(() => (load ? callFlowNodeSourceLoader(load) : undefined), [load]);
}
