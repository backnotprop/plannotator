import React from 'react';
import ReactDOM from 'react-dom/client';
import { SurfaceApp } from '@plannotator/inbox/surface/SurfaceApp';
import { NativeDiagramProvider } from '@plannotator/ui/components/diagram/NativeDiagramProvider';
import './surface.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Could not find root element to mount to');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <NativeDiagramProvider>
      <SurfaceApp />
    </NativeDiagramProvider>
  </React.StrictMode>,
);
