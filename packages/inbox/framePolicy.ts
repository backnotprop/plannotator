/**
 * What an HTML attachment's srcdoc frame may frame: this Inbox's own origin
 * only (pages of its folder, through the attachment asset route).
 *
 * The window's own policy already keeps `frame-src` at its origin (the live
 * pane frames its proxy through a same-origin wrapper page whose policy names
 * that one port: `liveFrameCsp` in packages/server/inbox-live.ts), and a
 * srcdoc frame inherits it. This policy, the srcdoc document's first element
 * (ui's `prependSrcdocPolicy`), says the same for every attachment drawn in
 * the window (the viewer, a linked page, the Artifacts thumbnails), so it
 * holds even if the window's policy is ever widened. It covers what the
 * document embeds only: where the frame navigates ITSELF is checked against
 * the window's policy, which is why that one must never name a local port.
 * Policies intersect, so the page cannot widen it.
 */
export function attachmentFramePolicy(): string {
  return `frame-src ${window.location.origin}`;
}
