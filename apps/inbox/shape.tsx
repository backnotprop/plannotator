import React from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeProvider } from '@plannotator/ui/components/ThemeProvider';
import { configurePlannotatorUI } from '@plannotator/ui/configure';
import { ShapePage } from '@plannotator/inbox/shape/standalone/ShapePage';
import { createShapePageApi } from '@plannotator/inbox/shape/standalone/api';
import { sceneFrameFromHash, setSceneFrame } from '@plannotator/ui/components/shape/scene/frame';
import './shape.css';

configurePlannotatorUI({
  serverSync: () => {},
  componentTooltips: true,
  webmcp: { enabled: false, namePrefix: 'plannotator.' },
  skillCatalogTransport: async () => [],
});

setSceneFrame(sceneFrameFromHash(window.location.hash));

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Could not find root element to mount to');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ThemeProvider defaultTheme="system">
      <ShapePage api={createShapePageApi()} />
    </ThemeProvider>
  </React.StrictMode>,
);
