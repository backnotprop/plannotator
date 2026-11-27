/**
 * The review window's load error detail line. What regresses: a proxy's HTML page shown as raw markup, a long body
 * shown whole, a JSON `error` that is not a string shown as the raw JSON, and the page's own code error
 * ("e.includes is not a function") shown to the person.
 */
import { describe, expect, test } from 'bun:test';
import { diffLoadFailureFromResponse, diffLoadFailureInfo } from './diffLoadFailure';

const detailOf = async (body: string, init: ResponseInit) => (await diffLoadFailureFromResponse(new Response(body, init))).info.detail;

describe('the load error detail line', () => {
  test("an HTML error page shows its first line of text, with no markup", async () => {
    const page = '<!DOCTYPE html>\n<html><head><title>502 Bad Gateway</title><style>body { color: red }</style></head>\n<body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx</center></body></html>';
    const detail = await detailOf(page, { status: 502, statusText: 'Bad Gateway' });
    expect(detail).toBe('502 Bad Gateway (HTTP 502)');
    expect(detail).not.toContain('<');
  });

  test('a long text body shows its first line, capped', async () => {
    const detail = (await detailOf(`fatal: ${'x'.repeat(500)}\n    at readTree (git.ts:12)`, { status: 500 }))!;
    expect(detail.startsWith('fatal: xxx')).toBe(true);
    expect(detail).not.toContain('readTree');
    expect(detail.length).toBeLessThanOrEqual(160 + ' (HTTP 500)'.length);
  });

  test("a JSON body's string error is shown; any other JSON falls back to the status text", async () => {
    expect(await detailOf(JSON.stringify({ error: 'Out of memory\nstack here' }), { status: 500 })).toBe('Out of memory (HTTP 500)');
    expect(await detailOf(JSON.stringify({ error: { code: 7 } }), { status: 500, statusText: 'Internal Server Error' })).toBe('Internal Server Error (HTTP 500)');
    expect(await detailOf('', { status: 404 })).toBe('HTTP 404');
  });

  test("the page's own failure to read the answer shows no code error", () => {
    const info = diffLoadFailureInfo(new TypeError('e.includes is not a function'));
    expect(info.detail).toBeNull();
    expect(info.summary).toBe('The changes for this review arrived but could not be shown.');
  });
});
