/**
 * A page that holds the file pane inside its own frame (the plan page, approval "inbox-plan-page-header-a3") draws
 * the pane's controls in its own bars: the pane's file-name row is not drawn (the page names the file), the
 * annotate tools and the comments button go into the page's bottom bar, the Viewer's own Global comment and Copy
 * file are offered from the page's menu, and a phone's Contents opens from that menu. Full screen keeps its own bar.
 */
import type { MutableRefObject, ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** What the page's menu calls in the pane. */
export interface PaneHostHandle {
  /** Open the global comment box at `anchor` (the control that asked); false when the file takes no comment. */
  globalComment: (anchor: HTMLElement) => boolean;
  /** Copy the file's text. */
  copy: () => Promise<boolean>;
}

export interface PaneHost {
  /** Where the annotate tools go (a slot in the page's bottom bar). */
  tools: HTMLElement | null;
  /** Where the comments button goes (beside Send). */
  comments: HTMLElement | null;
  /** The tools as marks only (a phone: their names are their accessible names). */
  marks?: boolean;
  /**
   * The page's own Global comment control (the Viewer's is hidden): where a saved global comment's box opens again
   * when the pane restores it. Absent or null: the Viewer's button, as before.
   */
  globalAnchor?: () => HTMLElement | null;
  /** Set while the pane is on screen. */
  handle: MutableRefObject<PaneHostHandle | null>;
  /** The phone's Contents sheet's opener, handed to the page (null when there is none). */
  onContents: (open: ((back: HTMLElement | null) => void) | null) => void;
}

/** `node` in the host's slot; nothing until the slot is there (it never floats over the file meanwhile). */
export function inHostSlot(slot: HTMLElement | null, node: ReactNode): ReactNode {
  return slot ? createPortal(node, slot) : null;
}
