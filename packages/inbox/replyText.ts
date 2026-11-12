import { useState, useSyncExternalStore } from 'react';

export interface ReplyText {
  get(): string;
  set(text: string): void;
  subscribe(listener: () => void): () => void;
}

export function createReplyText(initial = ''): ReplyText {
  let text = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => text,
    set(next) {
      if (next === text) return;
      text = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function useReplyTextStore(): ReplyText {
  return useState(() => createReplyText())[0];
}

export function useReplyText(store: ReplyText): string {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

export function useReplyTextWhile(store: ReplyText, on: boolean): string | null {
  const read = () => (on ? store.get() : null);
  return useSyncExternalStore(store.subscribe, read, read);
}

const holdsWords = (text: string) => text.trim() !== '';

export function useReplyHasWords(store: ReplyText): boolean {
  const read = () => holdsWords(store.get());
  return useSyncExternalStore(store.subscribe, read, read);
}
