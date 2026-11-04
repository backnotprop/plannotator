/**
 * The standalone Shape page (packages/inbox/shape/standalone/ShapePage.tsx):
 * what `plannotator shape open` serves to a person who does not use the
 * Plannotator Inbox. Built beside the window into dist/ (build:hook copies it
 * to apps/hook/dist/shape.html), with the window's plugins and aliases.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { ThemeProvider } from '@plannotator/ui/components/ThemeProvider';
import { configurePlannotatorUI } from '@plannotator/ui/configure';
import { ShapePage } from '@plannotator/inbox/shape/standalone/ShapePage';
import { createShapePageApi } from '@plannotator/inbox/shape/standalone/api';
import './shape.css';

configurePlannotatorUI({
  // No settings server here: the theme is the person's Plannotator theme (its cookie), else the system's.
  serverSync: () => {},
  componentTooltips: true,
  webmcp: { enabled: false, namePrefix: 'plannotator.' },
  skillCatalogTransport: async () => [],
});

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Could not find root element to mount to');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ThemeProvider defaultTheme="system">
      <ShapePage api={createShapePageApi()} />
    </ThemeProvider>
  </React.StrictMode>,
);
