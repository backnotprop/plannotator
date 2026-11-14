import { useMutation, useMutationState } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import type { InboxMessageWire } from '@plannotator/core/inbox-types';
import { useInboxQueryClient } from '../client';
import { inboxKeys } from '../keys';

export interface SendDrawn {
  threadId: string;
  key: string;
  words: string;
}

interface SendDraw extends SendDrawn {
  until: Promise<void>;
}

export interface SendDrawing {
  landed: () => void;
  stopped: () => void;
  carries: (idempotencyKey: string | null) => void;
}

const NOTHING: SendDrawing = { landed: () => {}, stopped: () => {}, carries: () => {} };
let drawings = 0;
const carriedBy = new Map<string, string>();

export function useDrawSend(): (drawn: Omit<SendDrawn, 'key'>) => SendDrawing {
  const client = useInboxQueryClient();
  const { mutate } = useMutation<void, Error, SendDraw>({ mutationKey: inboxKeys.sendDraw(), mutationFn: (draw) => draw.until }, client);
  return useCallback(
    (drawn) => {
      if (drawn.words === '') return NOTHING;
      let landed = () => {};
      let stopped = () => {};
      const key = `send-${++drawings}`;
      const until = new Promise<void>((resolve, reject) => {
        landed = () => resolve();
        stopped = () => reject(new Error('send stopped'));
      }).finally(() => carriedBy.delete(key));
      mutate({ ...drawn, key, until });
      const carries = (idempotencyKey: string | null) => {
        if (idempotencyKey) carriedBy.set(key, idempotencyKey);
      };
      return { landed, stopped, carries };
    },
    [mutate],
  );
}

export function useSendsDrawn(threadId: string, messages: readonly InboxMessageWire[]): readonly SendDrawn[] {
  const client = useInboxQueryClient();
  const drawn = useMutationState({ filters: { mutationKey: inboxKeys.sendDraw(), status: 'pending' }, select: (m) => m.state.variables as SendDraw }, client);
  return useMemo(() => {
    const landedKeys = new Set(messages.map((m) => m.idempotency_key).filter((k): k is string => typeof k === 'string'));
    return drawn.filter((d) => d.threadId === threadId && !landedKeys.has(carriedBy.get(d.key) ?? ''));
  }, [drawn, threadId, messages]);
}
