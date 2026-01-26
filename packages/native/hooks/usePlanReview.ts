/**
 * usePlanReview - Hook for plan review actions (approve/deny/feedback)
 */

import { useState, useCallback } from 'react';
import { Block, Annotation, exportDiff } from '@plannotator/core';

export type ReviewAction = 'approve' | 'deny' | 'feedback';

export interface ReviewResult {
  action: ReviewAction;
  feedback?: string;
  timestamp: number;
}

export interface UsePlanReviewReturn {
  isSubmitting: boolean;
  lastResult: ReviewResult | null;
  approve: () => Promise<ReviewResult>;
  deny: (reason?: string) => Promise<ReviewResult>;
  sendFeedback: (blocks: Block[], annotations: Annotation[], globalAttachments?: string[]) => Promise<ReviewResult>;
  reset: () => void;
}

export interface PlanReviewOptions {
  /**
   * Called when an action is performed
   */
  onAction?: (result: ReviewResult) => void;

  /**
   * API endpoint for submitting reviews (optional)
   * If not provided, actions are handled locally
   */
  apiEndpoint?: string;

  /**
   * Session ID for the current review
   */
  sessionId?: string;
}

/**
 * Hook for handling plan review actions
 */
export function usePlanReview(options: PlanReviewOptions = {}): UsePlanReviewReturn {
  const { onAction, apiEndpoint, sessionId } = options;
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lastResult, setLastResult] = useState<ReviewResult | null>(null);

  const handleResult = useCallback(
    (result: ReviewResult) => {
      setLastResult(result);
      onAction?.(result);
      return result;
    },
    [onAction]
  );

  const submitToApi = useCallback(
    async (action: ReviewAction, feedback?: string): Promise<void> => {
      if (!apiEndpoint) return;

      const endpoint = action === 'approve' ? '/api/approve' : '/api/deny';

      try {
        await fetch(`${apiEndpoint}${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            feedback,
          }),
        });
      } catch (error) {
        console.error('Failed to submit to API:', error);
        throw error;
      }
    },
    [apiEndpoint, sessionId]
  );

  const approve = useCallback(async (): Promise<ReviewResult> => {
    setIsSubmitting(true);
    try {
      await submitToApi('approve');
      const result: ReviewResult = {
        action: 'approve',
        timestamp: Date.now(),
      };
      return handleResult(result);
    } finally {
      setIsSubmitting(false);
    }
  }, [submitToApi, handleResult]);

  const deny = useCallback(
    async (reason?: string): Promise<ReviewResult> => {
      setIsSubmitting(true);
      try {
        await submitToApi('deny', reason);
        const result: ReviewResult = {
          action: 'deny',
          feedback: reason,
          timestamp: Date.now(),
        };
        return handleResult(result);
      } finally {
        setIsSubmitting(false);
      }
    },
    [submitToApi, handleResult]
  );

  const sendFeedback = useCallback(
    async (
      blocks: Block[],
      annotations: Annotation[],
      globalAttachments?: string[]
    ): Promise<ReviewResult> => {
      setIsSubmitting(true);
      try {
        const feedback = exportDiff(blocks, annotations, globalAttachments);
        await submitToApi('feedback', feedback);
        const result: ReviewResult = {
          action: 'feedback',
          feedback,
          timestamp: Date.now(),
        };
        return handleResult(result);
      } finally {
        setIsSubmitting(false);
      }
    },
    [submitToApi, handleResult]
  );

  const reset = useCallback(() => {
    setLastResult(null);
  }, []);

  return {
    isSubmitting,
    lastResult,
    approve,
    deny,
    sendFeedback,
    reset,
  };
}
