import React from 'react';
import ReactDOM from 'react-dom/client';
import { InboxApp, readSettingsAtLoad } from '@plannotator/inbox';
import { onCaughtRenderError, RegionBoundary } from '@plannotator/ui/components/RegionBoundary';
import './index.css';

readSettingsAtLoad();

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Could not find root element to mount to');

ReactDOM.createRoot(rootElement, { onCaughtError: onCaughtRenderError }).render(
  <React.StrictMode>
    {/* The last resort: a draw that throws past every region's own boundary never leaves the page blank. */}
    <RegionBoundary name="Inbox" page>
      <InboxApp />
    </RegionBoundary>
  </React.StrictMode>,
);
