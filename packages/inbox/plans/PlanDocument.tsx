/**
 * A plan version in the Inbox's own reader: the frame a Markdown file opened beside a thread is read in
 * (components/AttachmentPane.tsx: `.ib-docscroll`, the Clean look on the card colour, the 640 px column, and ui's
 * contents rail in the page's right gutter with the Contents button and sheet where it yields, contents.ts), around
 * the same Viewer (@plannotator/ui), read only. Under the rules for a plan's own words (planContent.tsx): no picture
 * is fetched but one written into the plan, no link but a web one does anything, and a diagram that could load
 * something is shown as its source.
 */
import { useLayoutEffect, useMemo, useState } from 'react';
import { Viewer } from '@plannotator/ui/components/Viewer';
import { DeferredMarkdownContentsRail } from '@plannotator/ui/components/DeferredMarkdownContentsRail';
import { CONTENTS_RAIL_MIN_PANE_WIDTH } from '@plannotator/ui/utils/annotationHelpers';
import type { PlanDocumentKind } from '@plannotator/core/plans';
import { PlanContentRules, PlanHtmlFrame, planBlocks, resolvePlanLink } from './planContent';
import { ScrollViewportProvider } from '@plannotator/ui/hooks/useScrollViewport';
import { diagramDocumentBlocks, parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { contentsButtonMode, showsContents, useContentsRailWaited, useContentsShown } from '../contents';
import { ContentsHide, ContentsPanel } from '../components/ContentsPanel';
import { useVersionText } from './store';

/** The reader's column, as a file beside a thread (AttachmentPane's Side by side). */
const READER_COLUMN = 640;

const noop = () => {};
const NO_ANNOTATIONS: [] = [];

/**
 * `doc` null: the plan's main page. A document's kind sets how it is drawn: Markdown by the Viewer; a Mermaid or
 * Graphviz file as its one diagram (under the same diagram rules); an HTML page in a frame that runs nothing.
 */
export function PlanDocument({ id, version, doc = null, kind = 'markdown', title = '', phone = false }: { id: string; version: number; doc?: string | null; kind?: PlanDocumentKind; title?: string; phone?: boolean }) {
  const [retry, setRetry] = useState(0);
  const { text, error } = useVersionText(id, version, retry, doc);
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const blocks = useMemo(() => {
    if (text === null || kind === 'html') return [];
    return planBlocks(kind === 'mermaid' || kind === 'graphviz' ? diagramDocumentBlocks(text, kind) : parseMarkdownToBlocks(text));
  }, [text, kind]);
  // Contents, as the reader's: ui's rail in the right gutter where the page is wide enough, else (and on a phone, or
  // hidden) the Contents button and sheet. Shown or hidden is the person's one choice for every document.
  const docKey = `${id}:${doc ?? ''}:${version}`;
  const [contentsShown, setContentsShown] = useContentsShown();
  const hasContents = text !== null && kind === 'markdown' && showsContents(blocks);
  const [railFit, setRailFit] = useState<{ key: string; fits: boolean } | null>(null);
  const railFits = railFit?.key === docKey ? railFit.fits : null;
  const [pageWidth, setPageWidth] = useState(0);
  useLayoutEffect(() => {
    if (!viewport) return;
    const measure = () => setPageWidth(viewport.getBoundingClientRect().width);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(viewport);
    return () => observer?.disconnect();
  }, [viewport]);
  const sideFits = !phone && pageWidth >= CONTENTS_RAIL_MIN_PANE_WIDTH;
  const railGutter = hasContents && sideFits && contentsShown;
  const waited = useContentsRailWaited(hasContents && !phone, `${docKey}:${contentsShown}`);
  const contentsButton = contentsButtonMode({ hasContents, phone, shown: contentsShown, sideFits, railFits, waited });
  if (error) {
    return (
      <div className="ib-plan-docstate" role="alert">
        <p>Version {version} could not be read. {error}</p>
        <button type="button" className="ib-plans-quiet" onClick={() => setRetry((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  }
  if (text === null) {
    return (
      <div className="ib-plan-docstate" role="status" aria-busy="true">
        <p>Loading v{version}…</p>
      </div>
    );
  }
  if (kind === 'html') {
    return (
      <div className="ib-plan-docscroll ib-plan-framewrap" data-plan-document={version}>
        <PlanHtmlFrame html={text} title={title || `Version ${version}`} />
      </div>
    );
  }
  return (
    <div className="ib-plan-docarea">
      {contentsButton && <ContentsPanel key={`contents:${docKey}`} mode={contentsButton} blocks={blocks} annotations={NO_ANNOTATIONS} scrollViewport={viewport} onShow={() => setContentsShown(true)} phone={phone} />}
    <div className="ib-docscroll ib-plan-reader bg-card" data-look="clean" data-contents-gutter={railGutter ? '' : undefined} ref={setViewport} data-plan-document={version}>
      <ScrollViewportProvider viewport={viewport}>
        <PlanContentRules>
          <Viewer
            key={`${id}:${doc ?? ''}:${version}`}
            blocks={blocks}
            markdown={text}
            annotations={NO_ANNOTATIONS}
            onAddAnnotation={noop}
            onSelectAnnotation={noop}
            selectedAnnotationId={null}
            questionDecisionLines={false}
            stickyActions={false}
            disableCodePathValidation
            maxWidth={railGutter ? null : READER_COLUMN}
            mode="selection"
            taterMode={false}
            readOnly
            resolveLocalLink={resolvePlanLink}
          />
        </PlanContentRules>
      </ScrollViewportProvider>
    </div>
      {hasContents && !phone && (
        <DeferredMarkdownContentsRail
          key={`rail:${docKey}`}
          blocks={blocks}
          scrollViewport={viewport}
          contentSelector="[data-doc-text-root]"
          hidden={!contentsShown}
          onAvailableChange={(fits) => setRailFit({ key: docKey, fits })}
          panelAction={<ContentsHide onHide={() => setContentsShown(false)} />}
        />
      )}
    </div>
  );
}
