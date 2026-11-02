/**
 * The reply box's words, held outside the thread pane's React state.
 *
 * Typing used to set state in `ThreadPane`, so every key re-rendered the
 * whole thread: every open message body, its question cards (React sets each
 * card input's `type` and `name` again on every render, which in Chromium
 * re-checks every `:has()` rule and restyles the whole page), the foot and
 * the list's pane. On a phone that was 50 to 80 ms a key (the owner's report
 * of 2026-11-02, "poor responsiveness in reply box"). Now the words live in
 * this store: the field reads them (`useReplyText`) and re-renders alone, and
 * the pane re-renders only when what it draws changes (`useReplyHasWords`:
 * whether the box holds words). Code that acts on the words (a Send, a save,
 * a restore) reads them as they are now with `get()`.
 */
import { useState, useSyncExternalStore } from 'react';

export interface ReplyText {
  /** The words as they are now. */
  get(): string;
  /** New words: everything that reads them hears it (the same words change nothing). */
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

/** One store for the life of the component (the reply box of one thread pane). */
export function useReplyTextStore(): ReplyText {
  return useState(() => createReplyText())[0];
}

/** The words, re-rendering the caller on every change: only what draws them (the field, full screen's card). */
export function useReplyText(store: ReplyText): string {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** The words while `on` (null otherwise): the caller re-renders on every change only while it draws them. */
export function useReplyTextWhile(store: ReplyText, on: boolean): string | null {
  const read = () => (on ? store.get() : null);
  return useSyncExternalStore(store.subscribe, read, read);
}

const holdsWords = (text: string) => text.trim() !== '';

/** Whether the words are more than spaces: re-renders the caller only when that flips. */
export function useReplyHasWords(store: ReplyText): boolean {
  const read = () => holdsWords(store.get());
  return useSyncExternalStore(store.subscribe, read, read);
}
