import React from 'react';
import ReactDOM from 'react-dom/client';
import { SnapshotsHudApp } from '@plannotator/snapshots-hud';
import '@plannotator/snapshots-hud/hud.css';

// In the native panel the window itself is the glass.
if (window.__SNAPSHOTS__?.native || window.webkit?.messageHandlers?.snapshots) document.documentElement.dataset.native = '';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Could not find root element to mount to');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <SnapshotsHudApp />
  </React.StrictMode>,
);
