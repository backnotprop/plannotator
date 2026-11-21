/**
 * A live `html` block's page while the person comments on it in place (the
 * owner's pick "A · In place", 2026-11-20): the page of `HtmlEmbedBlock`,
 * framed through ui's `HtmlViewer`, which adds its annotation bridge (the
 * boxed element, the comment box, the numbered markers).
 *
 * The boundary is the embed's, not the attached page's:
 * - The document is the embed's own (`buildEmbedDocument`: the same defaults
 *   and the same first script, so the same theme tokens, transparent
 *   background, height and Escape), with the bridge inlined by the viewer.
 *   The host keeps it and serves it under `EMBED_RESPONSE_CSP`
 *   (`HtmlEmbedAnnotate.frameUrl`), which loads nothing from the host.
 * - The frame's sandbox is `EMBED_SANDBOX`: never `allow-same-origin`.
 * - The embed's own messages (height, Escape) are read by the same reader
 *   from this frame's window only (`useEmbedMessages`); the bridge's by the
 *   viewer's, from this frame's window only. A link goes through the viewer's
 *   link guard and then the embed's own rule (`readEmbedMessage`,
 *   `openEmbedLink`).
 * - The comment's words are typed in the window's own comment box and are
 *   never sent to the page.
 * - An element with no text and no stable id (an SVG chart's bar) is
 *   anchored by its place in the document and its exact signature
 *   (`HtmlViewer` `structuralAnchors`). That is sound only because a block
 *   draws a comment only on the source it was made on (the embed id in
 *   `htmlBlockAnchor.id` is the source's hash): the same bytes, the same tree.
 *
 * Its own module, so the viewer and its bridge load only when a block is
 * first annotated.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildEmbedDocument, EMBED_SANDBOX, embedFragment, embedThemeMessage, readEmbedMessage, type EmbedTheme } from '@plannotator/core/html-embed';
import type { Annotation } from '../../types';
import { HtmlViewer, type HtmlViewerFrame } from '../html-viewer/HtmlViewer';
import type { ViewerHandle } from '../Viewer';
import { EMBED_FIRST_HEIGHT, openEmbedLink, useEmbedMessages } from './HtmlEmbedBlock';

export function AnnotatableEmbedFrame({
  html,
  frameUrl,
  theme,
  title,
  height,
  onHeight,
  onEscape,
  onReady,
  armed,
  onDisarm,
  annotations,
  onAdd,
  selectedId,
  onSelect,
  onUnanchored,
  allowImages,
}: {
  /** The fence's HTML, as written. */
  html: string;
  frameUrl: (document: string) => Promise<string | null>;
  theme: EmbedTheme;
  title: string;
  height?: number;
  onHeight: (height: number) => void;
  onEscape: (frame: HTMLIFrameElement | null) => void;
  onReady: () => void;
  /** The pen is on: a click on an element pins it. Off: the page is used as it is, and its markers stay. */
  armed: boolean;
  onDisarm: () => void;
  /** This block's comments, in marker order. */
  annotations: readonly Annotation[];
  /** False: the host did not keep the comment, and its marker leaves the page. */
  onAdd: (annotation: Annotation) => Promise<boolean>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** The comments given that found no element in the page (the complete set, after each restore). */
  onUnanchored: (ids: readonly string[]) => void;
  allowImages: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<ViewerHandle>(null);
  const frameOf = useCallback(() => boxRef.current?.querySelector('iframe') ?? null, []);
  // The embed's own document, with our <head> closed so the viewer's bridge lands in it, ahead of the page.
  const page = useMemo(() => buildEmbedDocument(html, { closeHead: true }), [html]);
  // The theme the page starts with rides in the address, as the embed's (no flash); later ones go by message.
  const [start] = useState(() => embedFragment(theme, 'inline'));
  const spoke = useRef(false);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const sendTheme = useCallback(() => frameOf()?.contentWindow?.postMessage(embedThemeMessage(themeRef.current), '*'), [frameOf]);
  useEmbedMessages(frameOf, {
    onHeight,
    onEscape,
    onReady: () => {
      spoke.current = true;
      // The theme may have changed while the page loaded.
      sendTheme();
      onReady();
    },
  });
  useEffect(() => {
    if (spoke.current) sendTheme();
  }, [theme, sendTheme]);

  const list = useMemo(() => [...annotations], [annotations]);
  const add = useCallback(
    (annotation: Annotation) => {
      void onAdd(annotation).then((kept) => {
        if (!kept) viewerRef.current?.removeHighlight(annotation.id);
      });
    },
    [onAdd],
  );
  // A link the person followed, from the viewer's link guard: a web link opens as the embed's does (the same
  // reader, the same rule), and a link that is only a query loads this page again with it, in place.
  const openLink = useCallback(
    (href: string, served?: HtmlViewerFrame) => {
      const frame = frameOf();
      if (!frame) return;
      const web = readEmbedMessage({ pnEmbed: 1, kind: 'link', url: href });
      if (web?.kind === 'link') openEmbedLink(frame, web.url);
      else if (href.charAt(0) === '?') {
        const at = href.indexOf('#');
        served?.reload(at < 0 ? href : href.slice(0, at), at < 0 ? start : href.slice(at));
      }
    },
    [frameOf, start],
  );

  return (
    <div ref={boxRef} data-html-embed-annotatable={armed ? 'annotate' : 'interact'}>
      <HtmlViewer
        ref={viewerRef}
        rawHtml={page}
        frameUrl={frameUrl}
        frameStart={start}
        sandbox={EMBED_SANDBOX}
        inline={{ height: height ?? EMBED_FIRST_HEIGHT, colorScheme: theme.scheme }}
        // The block hands over only the comments made on this very source (`matchHtmlBlockAnchor`: the embed
        // id is the source's hash), so an element with no text and no id (a chart's bar) may be anchored by
        // its place and its exact signature.
        structuralAnchors
        title={title}
        annotations={list}
        onAddAnnotation={add}
        onSelectAnnotation={onSelect}
        selectedAnnotationId={selectedId}
        mode="selection"
        inputMethod="pinpoint"
        annotateModeActive={armed}
        onAnnotateModeExit={onDisarm}
        // Off: the markers stay and open their comments; nothing new is made.
        readOnly={!armed}
        onOpenLink={openLink}
        onUnanchoredChange={onUnanchored}
        allowCommentImages={allowImages}
        maxWidth={null}
      />
    </div>
  );
}
