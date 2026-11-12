let commentCard = false;
let visibleCommentDrafts = false;

export interface CommentCardLayout {
  pane?: string;
  foot?: string;
}
let layout: CommentCardLayout = {};

let lastPointer: { x: number; t: number } | null = null;
let listening = false;
function listen(): void {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  document.addEventListener('pointerdown', (event) => { lastPointer = { x: event.clientX, t: performance.now() }; }, true);
}

export function setCommentCardEnabled(on: boolean | CommentCardLayout): void {
  commentCard = on !== false;
  layout = typeof on === 'object' ? { ...on } : {};
  if (commentCard) listen();
}

export function getCommentCardLayout(): CommentCardLayout {
  return layout;
}

export function getCommentCardEnabled(): boolean {
  return commentCard;
}

export function setVisibleCommentDrafts(on: boolean): void {
  visibleCommentDrafts = on;
}

export function getVisibleCommentDrafts(): boolean {
  return visibleCommentDrafts;
}

export function resetCommentCardPolicy(): void {
  commentCard = false;
  visibleCommentDrafts = false;
  layout = {};
  lastPointer = null;
}

export function commentCardAimX(): number | null {
  return lastPointer && performance.now() - lastPointer.t < 2000 ? lastPointer.x : null;
}
