import React from 'react';
import ReactDOM from 'react-dom/client';
import '../index.css';
import { setComponentTooltips } from '@plannotator/ui/components/HostTitle';
import { TooltipProvider } from '@plannotator/ui/components/Tooltip';
import { App } from './App';

// Cut names show ui's tooltip, as in the Inbox.
setComponentTooltips(true);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <TooltipProvider>
    <App />
  </TooltipProvider>,
);
