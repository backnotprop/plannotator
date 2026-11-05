import React from 'react';
import ReactDOM from 'react-dom/client';
import { InboxApp } from '@plannotator/inbox';
import { ReviewWorkerPoolProvider } from '@plannotator/review-editor/worker-pool';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Could not find root element to mount to');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ReviewWorkerPoolProvider>
      <InboxApp />
    </ReviewWorkerPoolProvider>
  </React.StrictMode>,
);
