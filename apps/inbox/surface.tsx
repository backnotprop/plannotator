import React from 'react';
import ReactDOM from 'react-dom/client';
import { SurfaceApp } from '@plannotator/inbox/surface/SurfaceApp';
import { onCaughtRenderError, RegionBoundary } from '@plannotator/ui/components/RegionBoundary';
import './surface.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Could not find root element to mount to');

ReactDOM.createRoot(rootElement, { onCaughtError: onCaughtRenderError }).render(
  <React.StrictMode>
    {/* The last resort: a draw that throws past every region's own boundary never leaves the page blank. */}
    <RegionBoundary name="Inbox" page>
      <SurfaceApp />
    </RegionBoundary>
  </React.StrictMode>,
);
