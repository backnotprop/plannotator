import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HtmlViewer } from '../../packages/ui/components/html-viewer/HtmlViewer';
import type { Annotation } from '../../packages/ui/types';
import { resourcePolicyFixture } from './html-viewer-resource-policy-fixture';

// agent-browser's console view does not include Chromium's native CSP log entries.
// Forward actual violation events from this frame for the standalone headed check.
addEventListener('message', event => {
  const frame = document.querySelector('iframe');
  if (event.source === frame?.contentWindow && event.data?.type === 'resource-policy-csp-report') {
    console.warn('Frame CSP:', event.data.directive, event.data.uri);
  }
});

const params = new URLSearchParams(location.search);
const rawHtml = resourcePolicyFixture(params.get('counter')!, params.get('run') ?? 'manual');
function Harness() {
  const [annotations, setAnnotations] = useState<Annotation[]>(() => JSON.parse(sessionStorage.getItem('annotations') ?? '[]'));
  const [armed, setArmed] = useState(false);
  return <>
    <header>
      <h1>HTML resource policy check</h1>
      <label><input type="checkbox" checked={armed} onChange={e => setArmed(e.target.checked)} />Annotate</label>
      <p>{params.has('control') ? 'Default policy' : 'Self-contained policy'}</p>
      <a href="/counts" target="_blank">Request counts</a>
    </header>
    <HtmlViewer rawHtml={rawHtml} resourcePolicy={params.has('control') ? undefined : 'self-contained'}
      annotations={annotations} onAddAnnotation={annotation => setAnnotations(previous => {
        const next = [...previous, annotation];
        sessionStorage.setItem('annotations', JSON.stringify(next));
        return next;
      })} onSelectAnnotation={() => {}} selectedAnnotationId={null}
      mode="selection" inputMethod="pinpoint" annotateModeActive={armed} hideControls />
    <section aria-label="Submitted annotations"><h2>Submitted annotations</h2>
      <pre id="annotations">{JSON.stringify(annotations, null, 2)}</pre>
    </section>
  </>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
