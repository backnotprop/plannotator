/**
 * What an error toast says (design record "inbox-toasts-break-fixes"): the
 * Inbox's own sentence, plain words when the Inbox did not answer, and the
 * caller's fallback for a program's own error. The cause itself goes to the
 * console, never the toast.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { InboxApiError, InboxHeldError } from './api';
import { errorText, errorToast, INBOX_UNREACHABLE } from './toastError';

const FALLBACK = 'The thread did not change.';
const realWarn = console.warn;
let warned: unknown[][] = [];

afterEach(() => {
  console.warn = realWarn;
  warned = [];
});

function captureWarn() {
  console.warn = (...args: unknown[]) => void warned.push(args);
}

describe('errorText', () => {
  test("the Inbox's own sentence, as it said it", () => {
    expect(errorText(new InboxApiError(409, 'thread_resolved', 'This thread is archived. Reopen it to reply.'), FALLBACK)).toBe('This thread is archived. Reopen it to reply.');
    expect(errorText(new InboxApiError(500, 'internal_error', '  '), FALLBACK)).toBe(FALLBACK);
  });

  test('a fetch that never reached the Inbox, in each browser\'s words: plain words and what to do', () => {
    for (const message of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.', 'The network connection was lost.']) {
      expect(errorText(new TypeError(message), FALLBACK)).toBe(INBOX_UNREACHABLE);
    }
  });

  test("a program's own error, or no error at all: the caller's words, never the program's", () => {
    expect(errorText(new TypeError("Cannot read properties of undefined (reading 'id')"), FALLBACK)).toBe(FALLBACK);
    expect(errorText(new SyntaxError('Unexpected token < in JSON at position 0'), FALLBACK)).toBe(FALLBACK);
    expect(errorText('SQLITE_BUSY: database is locked', FALLBACK)).toBe(FALLBACK);
    expect(errorText(undefined, FALLBACK)).toBe(FALLBACK);
    expect(errorText(new Error(''), FALLBACK)).toBe(FALLBACK);
  });

  test("a plain Error the window raised itself keeps its words", () => {
    expect(errorText(new Error('Pick a project first.'), FALLBACK)).toBe('Pick a project first.');
  });
});

describe('errorToast', () => {
  test('a warning that may wrap; what the toast does not say goes to the console', () => {
    captureWarn();
    const cause = new TypeError('Failed to fetch');
    expect(errorToast(cause, FALLBACK)).toEqual({ icon: 'warn', lead: INBOX_UNREACHABLE, wrap: true });
    expect(warned).toHaveLength(1);
    expect(warned[0]![1]).toBe(cause);
  });

  test('a write held for another machine did not fail: the clock, its own words, nothing logged', () => {
    captureWarn();
    const held = new InboxHeldError({} as ConstructorParameters<typeof InboxHeldError>[0], { name: 'Studio Mac', state: 'offline' } as ConstructorParameters<typeof InboxHeldError>[1]);
    expect(errorToast(held, FALLBACK)).toEqual({ icon: 'clock', lead: 'Waiting for Studio Mac: this applies when Studio Mac is back.', wrap: true });
    expect(warned).toHaveLength(0);
  });

  test("the Inbox's own answer is the whole story: nothing logged", () => {
    captureWarn();
    expect(errorToast(new InboxApiError(404, 'thread_not_found', 'This thread is gone.'), FALLBACK).lead).toBe('This thread is gone.');
    expect(warned).toHaveLength(0);
  });
});
