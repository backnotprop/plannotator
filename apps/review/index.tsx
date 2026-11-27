import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '@plannotator/review-editor';
import { ReviewWorkerPoolProvider } from '@plannotator/review-editor/worker-pool';
import { onCaughtRenderError, RegionBoundary } from '@plannotator/ui/components/RegionBoundary';
import '@plannotator/review-editor/styles';
import '@plannotator/review-editor/tree-styles';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement, { onCaughtError: onCaughtRenderError });
root.render(
  <React.StrictMode>
    {/* Worker-pool syntax highlighting — tokenization off the main thread
        (diffshub parity). Pierre's CodeView/FileDiff pick the pool up from
        context automatically. */}
    <ReviewWorkerPoolProvider>
      {/* The last resort: a draw that throws past every region's own boundary never leaves the page blank. */}
      <RegionBoundary name="Code review" page>
        <App />
      </RegionBoundary>
    </ReviewWorkerPoolProvider>
  </React.StrictMode>
);
