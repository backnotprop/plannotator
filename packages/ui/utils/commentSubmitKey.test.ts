/**
 * Guards: the default (Enter is a new line) drifting, Cmd/Ctrl+Enter lost with the setting on,
 * Shift+Enter or Alt+Enter saving, and an IME Enter saving, in both the DOM event shape and
 * React's synthetic shape (`nativeEvent`).
 */
import { describe, expect, test } from 'bun:test';
import { isCommentSubmitKey, isImeCompositionKey } from './commentSubmitKey';

const enter = (extra: Record<string, unknown> = {}) => ({ key: 'Enter', ...extra });

describe('isCommentSubmitKey', () => {
  test('off: only Cmd/Ctrl+Enter saves', () => {
    expect(isCommentSubmitKey(enter(), false)).toBe(false);
    expect(isCommentSubmitKey(enter({ metaKey: true }), false)).toBe(true);
    expect(isCommentSubmitKey(enter({ ctrlKey: true }), false)).toBe(true);
  });

  test('on: plain Enter saves; Shift+Enter and Alt+Enter do not', () => {
    expect(isCommentSubmitKey(enter(), true)).toBe(true);
    expect(isCommentSubmitKey(enter({ shiftKey: true }), true)).toBe(false);
    expect(isCommentSubmitKey(enter({ altKey: true }), true)).toBe(false);
    expect(isCommentSubmitKey(enter({ ctrlKey: true }), true)).toBe(true);
    expect(isCommentSubmitKey(enter({ metaKey: true, shiftKey: true }), true)).toBe(true);
  });

  test('never another key', () => {
    expect(isCommentSubmitKey({ key: 'a', ctrlKey: true }, true)).toBe(false);
    expect(isCommentSubmitKey({ key: 'NumpadEnter' }, true)).toBe(false);
  });

  test('an IME Enter never saves, in either event shape and in either mode', () => {
    for (const enterSaves of [false, true]) {
      expect(isCommentSubmitKey(enter({ isComposing: true }), enterSaves)).toBe(false);
      expect(isCommentSubmitKey(enter({ keyCode: 229 }), enterSaves)).toBe(false);
      expect(isCommentSubmitKey(enter({ nativeEvent: { isComposing: true } }), enterSaves)).toBe(false);
      expect(isCommentSubmitKey(enter({ nativeEvent: { keyCode: 229 }, ctrlKey: true }), enterSaves)).toBe(false);
    }
    expect(isImeCompositionKey(enter({ keyCode: 13 }))).toBe(false);
  });
});
