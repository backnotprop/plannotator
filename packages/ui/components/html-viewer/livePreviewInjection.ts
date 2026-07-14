import { ANNOTATION_HIGHLIGHT_CSS, BRIDGE_SCRIPT } from "./bridge-script";

/**
 * The block injected into a LIVE (proxied) HTML page: annotation highlight CSS
 * + the postMessage bridge. Shared with the srcdoc path so annotation behaves
 * identically. No theme tokens — a real dev app owns its styling and does not
 * opt into host theming.
 */
export function buildLivePreviewInjection(): string {
  return `<style>${ANNOTATION_HIGHLIGHT_CSS}</style><script>${BRIDGE_SCRIPT}</script>`;
}
