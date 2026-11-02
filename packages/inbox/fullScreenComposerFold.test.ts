/**
 * The full-screen card's fold across views of one thread (approval
 * "inbox-html-attachments-phone"): an HTML page on a phone opens clear with the
 * reply in the pill, while an image on the same thread keeps its open card, and
 * a comment on the page opens the card and puts it back as it found it.
 */
import { beforeEach, expect, test } from 'bun:test';
import { composerMinimized, composerModeFor, forgetComposerOpened, openComposerComment, pickComposerMode, resetComposerState, setComposerMinimized, showComposerComment } from './fullScreenComposer';

const T = 'thread-1';

beforeEach(() => resetComposerState());

// Failure to catch: folding for HTML being stored for the thread, which would fold the next image's comment row.
test('the fold is the view default, not a state of the thread', () => {
  expect(composerMinimized(T, true)).toBe(true);
  expect(composerMinimized(T)).toBe(false);
});

// Failure to catch: the person's own fold being overridden when they step to an image.
test("the person's fold beats any view's default, either way", () => {
  setComposerMinimized(T, true);
  expect(composerMinimized(T)).toBe(true);
  setComposerMinimized(T, false);
  expect(composerMinimized(T, true)).toBe(false);
});

// Failure to catch: a card opened on one file covering the next phone HTML page, or a fold being lost.
test('opening a phone page forgets an opened card and keeps a folded one', () => {
  setComposerMinimized(T, false);
  forgetComposerOpened(T);
  expect(composerMinimized(T, true)).toBe(true);
  setComposerMinimized(T, true);
  forgetComposerOpened(T);
  expect(composerMinimized(T)).toBe(true);
});

// Failure to catch: a saved comment leaving the card open on the page, or changing the tab the reply was on.
test('a comment opens the Comment tab, and its restore puts back what it found', () => {
  pickComposerMode(T, 'reply');
  const restore = openComposerComment(T);
  expect(composerModeFor(T, false, true)).toBe('comment');
  expect(composerMinimized(T, true)).toBe(false);
  restore();
  expect(composerModeFor(T, false, true)).toBe('reply');
  expect(composerMinimized(T, true)).toBe(true);
});

// Failure to catch: the person going to Reply mid-comment, and the next pin opening behind it.
test('a new target shows the comment again, and restore still goes back to the start', () => {
  const restore = openComposerComment(T);
  pickComposerMode(T, 'reply');
  showComposerComment(T);
  expect(composerModeFor(T, false, true)).toBe('comment');
  restore();
  expect(composerModeFor(T, false, true)).toBe('comment');
  expect(composerMinimized(T, true)).toBe(true);
  expect(composerModeFor(T, true, true)).toBe('reply');
});
