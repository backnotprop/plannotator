/**
 * A running local site, framed through a
 * host's live proxy, with pinpoint annotation. A thin layer over HtmlViewer's
 * live (`src`) mode that owns what every host of a live site does the same
 * way, so it stops living inline in one app:
 *
 * - the page the person is on (`ready` / `page-change` reports), so restore
 *   shows only that page's pins;
 * - stamping each new page-located annotation with that page (`pageUrl`),
 *   as annotate's App.tsx `handleAddAnnotation` does; global comments stay
 *   unstamped.
 *
 * Everything else is HtmlViewer, unchanged: the token and origin checks on
 * every bridge message, the comment-only clamp, Annotate/Interact, the Esc
 * ladder. The host owns the proxy, the token and where comments are stored.
 * Annotate's App keeps its inline copy today (Plannotator unchanged); it can
 * move onto this component once parity is checked in a browser.
 */

import { forwardRef, useCallback, useState } from "react";
import { HtmlViewer, type HtmlViewerProps } from "./HtmlViewer";
import { AnnotationType, type Annotation } from "../../types";

export interface LiveSiteViewerProps
  extends Omit<HtmlViewerProps, "rawHtml" | "src" | "liveSession" | "currentPageUrl" | "onPageChange" | "fullViewport" | "inputMethod" | "vimModeEnabled" | "onOpenLink"> {
  /**
   * What the frame loads: the proxy's URL (host's localhost spelling, the
   * target's path and query), or, with `liveNested`, the host's same-origin
   * wrapper page that frames it.
   */
  appUrl: string;
  /** The proxy's origin the bridge posts from, and the per-proxy token it stamps. */
  proxyOrigin: string;
  token: string;
  /**
   * Optional: `appUrl` is the host's same-origin wrapper page whose only
   * frame is the proxy (`HtmlLiveSession.nested`). Absent: `appUrl` is the
   * proxy itself, as annotate frames it.
   */
  liveNested?: boolean;
  /** Reports the page the person is on (pathname + search), for a host's route chip. */
  onPageChange?: (pageUrl: string) => void;
}

export const LiveSiteViewer = forwardRef<unknown, LiveSiteViewerProps>(function LiveSiteViewer(
  { appUrl, proxyOrigin, token, liveNested, onPageChange, onAddAnnotation, ...rest },
  ref,
) {
  const [pageUrl, setPageUrl] = useState<string | undefined>(undefined);
  const onPage = useCallback(
    (next: string) => {
      setPageUrl(next);
      onPageChange?.(next);
    },
    [onPageChange],
  );
  const add = useCallback(
    (annotation: Annotation) =>
      onAddAnnotation(pageUrl && annotation.type !== AnnotationType.GLOBAL_COMMENT ? { ...annotation, pageUrl } : annotation),
    [onAddAnnotation, pageUrl],
  );
  return (
    <HtmlViewer
      {...rest}
      ref={ref as never}
      rawHtml=""
      src={appUrl}
      liveSession={liveNested ? { origin: proxyOrigin, token, nested: true } : { origin: proxyOrigin, token }}
      currentPageUrl={pageUrl}
      onPageChange={onPage}
      onAddAnnotation={add}
      inputMethod="pinpoint"
      // Vim's keyboard cursor would write into the app's own DOM (annotate turns it off on live sites too).
      vimModeEnabled={false}
      fullViewport
    />
  );
});
