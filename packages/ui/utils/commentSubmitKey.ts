export interface CommentSubmitKeyEvent {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}

export function isImeCompositionKey(event: CommentSubmitKeyEvent): boolean {
  return (
    event.isComposing === true ||
    event.nativeEvent?.isComposing === true ||
    event.keyCode === 229 ||
    event.nativeEvent?.keyCode === 229
  );
}

export function isCommentSubmitKey(event: CommentSubmitKeyEvent, enterSaves: boolean): boolean {
  if (event.key !== 'Enter') return false;
  if (isImeCompositionKey(event)) return false;
  if (event.metaKey || event.ctrlKey) return true;
  return enterSaves && !event.shiftKey && !event.altKey;
}
