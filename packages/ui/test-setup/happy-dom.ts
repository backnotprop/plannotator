// Registers happy-dom globals for tests that mount React components (CM6 editor).
// Opt-in via DOM_TESTS=1 so the default `bun test` run keeps its native globals —
// happy-dom's window/fetch globals break server-oriented tests (cookie-proxy, ipc-server).
import { GlobalRegistrator } from '@happy-dom/global-registrator';

if (process.env.DOM_TESTS === '1' && typeof document === 'undefined') {
  GlobalRegistrator.register();
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
}
