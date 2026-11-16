/**
 * A plan version drawn by the document UI's Viewer (@plannotator/ui), read only, as the Inbox draws a linked
 * Markdown page (components/LinkedMarkdown.tsx). Pictures the plan names by a path on the agent's computer are not
 * fetched (a quiet placeholder with their alt text); only a picture written into the plan (`data:`) shows.
 */
import { useCallback, useMemo, useState } from 'react';
import { Viewer } from '@plannotator/ui/components/Viewer';
import { ImageResolverContext, type ImageResolver } from '@plannotator/ui/components/ImageResolverContext';
import { ScrollViewportProvider } from '@plannotator/ui/hooks/useScrollViewport';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import { useVersionText } from './store';

const noop = () => {};
const NO_ANNOTATIONS: [] = [];

export function PlanDocument({ id, version }: { id: string; version: number }) {
  const [retry, setRetry] = useState(0);
  const { text, error } = useVersionText(id, version, retry);
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const blocks = useMemo(() => (text === null ? [] : parseMarkdownToBlocks(text)), [text]);
  const resolveImage = useCallback<ImageResolver>((src) => (/^data:image\//i.test(src) ? { kind: 'src', src } : { kind: 'unavailable', title: src }), []);
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
  return (
    <div className="ib-plan-docscroll" ref={setViewport} data-plan-document={version}>
      <ScrollViewportProvider viewport={viewport}>
        <ImageResolverContext.Provider value={resolveImage}>
          <Viewer
            key={`${id}:${version}`}
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
          />
        </ImageResolverContext.Provider>
      </ScrollViewportProvider>
    </div>
  );
}
