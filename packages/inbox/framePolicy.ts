/**
 * What an HTML attachment's srcdoc frame may frame: this Inbox's own origin
 * only (pages of its folder, through the attachment asset route).
 *
 * The window's page allows `http://localhost:*` frames so the live-site pane
 * can frame its proxy (LOCAL_WINDOW_CSP in packages/server/inbox.ts), and a
 * srcdoc frame inherits the page's policy. This policy, the srcdoc
 * document's first element (ui's `prependSrcdocPolicy`), takes that back for
 * every attachment drawn in the window: the viewer, a linked page, and the
 * Artifacts thumbnails. Policies intersect, so the page cannot widen it.
 */
export function attachmentFramePolicy(): string {
  return `frame-src ${window.location.origin}`;
}
