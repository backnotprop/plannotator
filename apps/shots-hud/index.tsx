import React from 'react';
import ReactDOM from 'react-dom/client';
import { ShotsHudApp } from '@plannotator/shots-hud';
import '@plannotator/shots-hud/hud.css';

// In the native panel the window itself is the glass.
if (window.__SHOTS__?.native || window.webkit?.messageHandlers?.shots) document.documentElement.dataset.native = '';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Could not find root element to mount to');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ShotsHudApp />
  </React.StrictMode>,
);
