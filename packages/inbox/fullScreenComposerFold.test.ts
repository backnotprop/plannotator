import { beforeEach, expect, test } from 'bun:test';
import { composerMinimized, composerModeFor, forgetComposerOpened, openComposerComment, pickComposerMode, resetComposerState, setComposerMinimized, showComposerComment } from './fullScreenComposer';

const T = 'thread-1';

beforeEach(() => resetComposerState());

test('the fold is the view default, not a state of the thread', () => {
  expect(composerMinimized(T, true)).toBe(true);
  expect(composerMinimized(T)).toBe(false);
});

test("the person's fold beats any view's default, either way", () => {
  setComposerMinimized(T, true);
  expect(composerMinimized(T)).toBe(true);
  setComposerMinimized(T, false);
  expect(composerMinimized(T, true)).toBe(false);
});

test('opening a phone page forgets an opened card and keeps a folded one', () => {
  setComposerMinimized(T, false);
  forgetComposerOpened(T);
  expect(composerMinimized(T, true)).toBe(true);
  setComposerMinimized(T, true);
  forgetComposerOpened(T);
  expect(composerMinimized(T)).toBe(true);
});

test('a comment opens the Comment tab, and its restore puts back what it found', () => {
  pickComposerMode(T, 'reply');
  const restore = openComposerComment(T);
  expect(composerModeFor(T, false, true)).toBe('comment');
  expect(composerMinimized(T, true)).toBe(false);
  restore();
  expect(composerModeFor(T, false, true)).toBe('reply');
  expect(composerMinimized(T, true)).toBe(true);
});

// The pane forgets the opened card in a layout effect, and the old page's draft restores its fold later, in its passive cleanup.
test('a card opened, then a comment, then the next page: the restore keeps the page clear', () => {
  setComposerMinimized(T, false);
  const restore = openComposerComment(T);
  forgetComposerOpened(T);
  restore();
  expect(composerMinimized(T, true)).toBe(true);
  setComposerMinimized(T, false);
  openComposerComment(T)();
  expect(composerMinimized(T, true)).toBe(false);
});

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
