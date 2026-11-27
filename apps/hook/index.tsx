import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '@plannotator/editor';
import '@plannotator/editor/styles';
import { onCaughtRenderError, RegionBoundary } from '@plannotator/ui/components/RegionBoundary';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement, { onCaughtError: onCaughtRenderError });
root.render(
  <React.StrictMode>
    {/* The last resort: a draw that throws past every region's own boundary never leaves the page blank. */}
    <RegionBoundary name="Plan review" page>
      <App />
    </RegionBoundary>
  </React.StrictMode>
);