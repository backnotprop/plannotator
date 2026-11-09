import React from 'react';
import ReactDOM from 'react-dom/client';
import { InboxApp } from '@plannotator/inbox';
import './index.css';
import { startPxFlags } from '../../packages/inbox/px/flags';

// PROTOTYPE (proto/composer-picker): the redesign's three live switches.
startPxFlags();

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Could not find root element to mount to');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <InboxApp />
  </React.StrictMode>,
);
