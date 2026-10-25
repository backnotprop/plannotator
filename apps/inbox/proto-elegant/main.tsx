// The real Inbox window, exactly as apps/inbox/index.tsx mounts it. Only the stylesheet differs.
import React from 'react';
import ReactDOM from 'react-dom/client';
import { InboxApp } from '@plannotator/inbox';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Could not find root element to mount to');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <InboxApp />
  </React.StrictMode>,
);
