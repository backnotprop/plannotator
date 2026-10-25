import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { GTProvider, initializeGT } from 'gt-react';
import { AnimationProvider } from '@halftone/animations/animation-provider';
import { Tooltip } from '@halftone/design-system/primitives/tooltip';
import { App } from './App';
import '../styles.css';

initializeGT({ defaultLocale: 'en', locales: ['en'] });

const root = document.getElementById('root');
if (!root) throw new Error('no #root');

createRoot(root).render(
  <StrictMode>
    <GTProvider locale="en" translations={{}}>
      <AnimationProvider>
        <Tooltip.Provider>
          <App />
        </Tooltip.Provider>
      </AnimationProvider>
    </GTProvider>
  </StrictMode>,
);
