import { afterEach, describe, it, expect, mock, beforeEach } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { SessionProvider, useSessionFetch } from './useSessionFetch';

let captured: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];

function Capture() {
  captured = useSessionFetch();
  return null;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  calls.length = 0;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input, init });
    return Promise.resolve(new Response('ok'));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('useSessionFetch', () => {
  describe('with SessionProvider', () => {
    function render(sessionId: string) {
      renderToString(
        createElement(SessionProvider, { sessionId, children: createElement(Capture) }),
      );
    }

    it('rewrites /api/ paths to session-scoped paths', () => {
      render('sess_abc123');
      captured('/api/diff');
      expect(calls[0].input).toBe('/s/sess_abc123/api/diff');
    });

    it('rewrites bare /api to session base', () => {
      render('sess_1');
      captured('/api');
      expect(calls[0].input).toBe('/s/sess_1/api');
    });

    it('preserves query strings', () => {
      render('sess_1');
      captured('/api/external-annotations?since=5');
      expect(calls[0].input).toBe('/s/sess_1/api/external-annotations?since=5');
    });

    it('passes through non-api paths unchanged', () => {
      render('sess_1');
      captured('/daemon/status');
      expect(calls[0].input).toBe('/daemon/status');
    });

    it('passes through external URLs unchanged', () => {
      render('sess_1');
      captured('https://api.github.com/repos');
      expect(calls[0].input).toBe('https://api.github.com/repos');
    });

    it('passes init options through', () => {
      render('sess_1');
      const init = { method: 'POST', body: '{}' };
      captured('/api/feedback', init);
      expect(calls[0].input).toBe('/s/sess_1/api/feedback');
      expect(calls[0].init).toBe(init);
    });

    it('handles template-literal paths with interpolation', () => {
      render('sess_1');
      const jobId = 'job_42';
      captured(`/api/tour/${jobId}`);
      expect(calls[0].input).toBe('/s/sess_1/api/tour/job_42');
    });
  });

  describe('without SessionProvider', () => {
    it('passes api paths through unchanged', () => {
      renderToString(createElement(Capture));
      captured('/api/diff');
      expect(calls[0].input).toBe('/api/diff');
    });

    it('passes non-api paths through unchanged', () => {
      renderToString(createElement(Capture));
      captured('/daemon/status');
      expect(calls[0].input).toBe('/daemon/status');
    });
  });
});
