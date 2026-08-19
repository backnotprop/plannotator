import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

type CloudFrontRequest = {
  uri: string;
};

type CloudFrontResult = CloudFrontRequest | {
  statusCode: number;
  headers: Record<string, { value: string }>;
};

const source = readFileSync(new URL('./url-rewrite.js', import.meta.url), 'utf8');
const handler = new Function(`${source}; return handler;`)() as (event: {
  request: CloudFrontRequest;
}) => CloudFrontResult;

function run(uri: string): CloudFrontResult {
  return handler({ request: { uri } });
}

describe('marketing CloudFront URL handling', () => {
  test('redirects old documentation URLs directly to the matching new page', () => {
    expect(run('/docs/getting-started/installation')).toEqual({
      statusCode: 301,
      statusDescription: 'Moved Permanently',
      headers: {
        location: { value: 'https://docs.plannotator.ai/open-source/start/installation' },
        'cache-control': { value: 'public, max-age=3600' },
      },
    });
  });

  test('handles trailing-slash variants in the same redirect hop', () => {
    expect(run('/docs/getting-started/installation/')).toEqual(
      run('/docs/getting-started/installation'),
    );
  });

  test('redirects the legacy self-hosting guide directly to its canonical Docs page', () => {
    const result = run('/docs/guides/self-hosting') as {
      statusCode: number;
      headers: Record<string, { value: string }>;
    };

    expect(result.statusCode).toBe(301);
    expect(result.headers.location.value).toBe(
      'https://docs.plannotator.ai/open-source/self-hosting',
    );
    expect(run('/docs/guides/self-hosting/')).toEqual(result);
  });

  test('redirects the old sharing article directly to the current sharing guide', () => {
    const result = run('/blog/sharing-plans-with-your-team') as {
      statusCode: number;
      headers: Record<string, { value: string }>;
    };

    expect(result.statusCode).toBe(301);
    expect(result.headers.location.value).toBe(
      'https://docs.plannotator.ai/open-source/workflows/sharing',
    );
    expect(run('/blog/sharing-plans-with-your-team/')).toEqual(
      result,
    );
  });

  test('keeps the existing static-site rewrite for non-migrated routes', () => {
    expect(run('/code-review')).toEqual({ uri: '/code-review/index.html' });
    expect(run('/')).toEqual({ uri: '/index.html' });
    expect(run('/assets/icon-codex.png')).toEqual({ uri: '/assets/icon-codex.png' });
  });

  test('fits within the CloudFront Functions code-size limit', () => {
    expect(Buffer.byteLength(source, 'utf8')).toBeLessThanOrEqual(10_000);
  });
});
