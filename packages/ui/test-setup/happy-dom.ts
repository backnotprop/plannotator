import { GlobalRegistrator } from '@happy-dom/global-registrator';

if (process.env.DOM_TESTS === '1' && typeof document === 'undefined') {
  GlobalRegistrator.register();
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
}
