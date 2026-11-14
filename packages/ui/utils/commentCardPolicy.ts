/**
 * The comment card and visible comment drafts (both opt-in; Plannotator Inbox,
 * approval "inbox-comment-box", round 3).
 *
 * `commentCard`: `CommentPopover` draws as a small card by the words it is
 * about: no header line, no blurred page behind (a phone or a box opened to
 * full docks it at the foot of the view instead), a chevron at the top right
 * that closes it and keeps the words, one row with the tools at the left, the
 * bin, and a solid "Comment" button at the right end. The card's look ships in
 * `@plannotator/ui/comment-card.css`, which a host that turns this on imports.
 *
 * `visibleCommentDrafts`: closing a text-selection comment that holds words
 * (the chevron, Escape) keeps its words highlighted, palely, with a floating
 * "Draft" badge under their end (the Viewer); a press on either opens the box
 * again with the words.
 *
 * Default: both false, so a host that does not opt in (plan review, code
 * review, Workspaces) renders exactly as before.
 */
let commentCard = false;
let visibleCommentDrafts = false;

/** Where the card goes, in the host's own markup (CSS selectors). */
export interface CommentCardLayout {
  /** The pane the words are in: docked, the card spans its foot (absent: the visible viewport). */
  pane?: string;
  /** Things at a pane's foot the card never covers (a reply bar, a floating composer): it ends above them. */
  foot?: string;
}
let layout: CommentCardLayout = {};

// Where the pointer last went down (the toolbar's Comment, a pin): the card puts its Comment button under it, so the
// hand barely moves to send. Installed only once a host turns the card on.
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

/** The x of the last pointer press, when it was under 2 s ago (a keyboard open has none). */
export function commentCardAimX(): number | null {
  return lastPointer && performance.now() - lastPointer.t < 2000 ? lastPointer.x : null;
}
