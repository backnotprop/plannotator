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

export type CallFlowNodeSource = ReviewFileSource;

export type CallFlowNodeSourceLoader = (node: CallFlowNode) => Promise<CallFlowNodeSource | null>;

export function callFlowNodeSourceLoader(load: ReviewFileSourceLoader): CallFlowNodeSourceLoader {
  return async (node) => {
    if (!node.file || !node.line) return null;
    return load(node.file, node.status === 'removed' ? 'old' : 'new');
  };
}

export function createCallFlowNodeSourceLoader(options: ReviewFileSourceOptions): CallFlowNodeSourceLoader {
  return callFlowNodeSourceLoader(createReviewFileSourceLoader(options));
}

export function useCallFlowNodeSource(state: ReviewState | null): CallFlowNodeSourceLoader | undefined {
  const load = useReviewFileSource(state);
  return useMemo(() => (load ? callFlowNodeSourceLoader(load) : undefined), [load]);
}
