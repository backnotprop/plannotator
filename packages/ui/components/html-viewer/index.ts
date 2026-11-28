export {
  DEFAULT_BRIDGE_READY_TIMEOUT_MS,
  HTML_VIEWER_FRAME_GONE,
  HtmlViewer,
  formatBridgeUnavailableMessage,
  servedFrameReloadUrl, servedFrameStartUrl,
  type HtmlViewerFrame,
  type BridgeUnavailableInfo,
  type HtmlViewerInline,
  type HtmlViewerProps,
} from "./HtmlViewer";
export { BRIDGE_PROTOCOL_VERSION } from "./bridge-script";
// Bridge protocol 2, for a host that builds the frame's document itself (README § "What a host must change for
// bridge protocol 2"): a key per load, the link guard first in the document, a served address that carries the key.
export { LINK_CLICK_MESSAGE, LINK_OFFER_MESSAGE, newLinkKey, withLinkKey } from "./linkGuard";
export { injectLinkGuard } from "./srcdoc";
export {
  checkBridgeProtocolVersion,
  formatBridgeProtocolWarning,
  type BridgeProtocolVerdict,
  type HtmlContentWidth,
  type HtmlScrollClear,
} from "./useHtmlAnnotation";
export {
  buildPersistedHtmlAnchor,
  projectHostThreads,
  type BuildPersistedHtmlAnchorOptions,
  type HostThread,
  type PersistedHtmlAnchor,
  type PersistedHtmlAnchorResult,
  type ProjectHostThreadsOptions,
} from "./hostThreads";
// A live proxied site with page tracking and pageUrl stamping (the Inbox's live sites).
export { LiveSiteViewer, type LiveSiteViewerProps } from "./LiveSiteViewer";
