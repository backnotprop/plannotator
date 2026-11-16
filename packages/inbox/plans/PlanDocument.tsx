/**
 * A plan version drawn by the document UI's Viewer (@plannotator/ui), read only, as the Inbox draws a linked
 * Markdown page (components/LinkedMarkdown.tsx), under the rules for a plan's own words (planContent.tsx): no picture
 * is fetched but one written into the plan, no link but a web one does anything, and a diagram that could load
 * something is shown as its source.
 */
import { useMemo, useState } from 'react';
import { Viewer } from '@plannotator/ui/components/Viewer';
import type { PlanDocumentKind } from '@plannotator/core/plans';
import { PlanContentRules, PlanHtmlFrame, planBlocks, resolvePlanLink } from './planContent';
import { ScrollViewportProvider } from '@plannotator/ui/hooks/useScrollViewport';
import { diagramDocumentBlocks, parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { useVersionText } from './store';

const noop = () => {};
const NO_ANNOTATIONS: [] = [];

/**
 * `doc` null: the plan's main page. A document's kind sets how it is drawn: Markdown by the Viewer; a Mermaid or
 * Graphviz file as its one diagram (under the same diagram rules); an HTML page in a frame that runs nothing.
 */
export function PlanDocument({ id, version, doc = null, kind = 'markdown', title = '' }: { id: string; version: number; doc?: string | null; kind?: PlanDocumentKind; title?: string }) {
  const [retry, setRetry] = useState(0);
  const { text, error } = useVersionText(id, version, retry, doc);
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const blocks = useMemo(() => {
    if (text === null || kind === 'html') return [];
    return planBlocks(kind === 'mermaid' || kind === 'graphviz' ? diagramDocumentBlocks(text, kind) : parseMarkdownToBlocks(text));
  }, [text, kind]);
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
    <div className="ib-plan-docscroll" ref={setViewport} data-plan-document={version}>
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
            maxWidth={760}
            mode="selection"
            taterMode={false}
            readOnly
            resolveLocalLink={resolvePlanLink}
          />
        </PlanContentRules>
      </ScrollViewportProvider>
    </div>
  );
}
