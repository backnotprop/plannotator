/**
 * The answer the window itself read for a write, for specs that need what a Send answered (a start's thread and launch).
 *
 * Not `page.waitForResponse(...).json()`: that body is DevTools' copy, and Chromium does not always keep one. The window
 * reads a write's answer as a stream (packages/inbox/apiBody.ts `wholeBody`, so a Send whose answer stops arriving ends),
 * and for a `no-store` answer (every Inbox JSON answer) read that way whose body comes in more than one piece, Chromium
 * tells DevTools the request was aborted and keeps no body ("No data found for resource with given identifier"), though
 * the page read every byte (microsoft/playwright#42742, a Chromium bug). So the answer is read in the page, from a copy
 * of the very Response the window reads. Its status and request stay on `waitForResponse`, which is not affected.
 */
import type { Page } from '@playwright/test';

/**
 * Watches the window's next POST to `pathname`; returns a read of its answer's JSON (call it after the press that sends).
 * Set it after the page loads and before the press: a reload in between drops the watch.
 */
export async function nextPostAnswer<T>(page: Page, pathname: string): Promise<() => Promise<T>> {
  await page.evaluate((watched) => {
    const own = window.fetch;
    (window as unknown as { __e2eAnswer?: Promise<string> }).__e2eAnswer = new Promise<string>((resolve, reject) => {
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await own(input, init);
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        if (url.pathname === watched && method === 'POST') {
          window.fetch = own;
          response.clone().text().then(resolve, reject);
        }
        return response;
      };
    });
  }, pathname);
  return async () => JSON.parse(await page.evaluate(() => (window as unknown as { __e2eAnswer: Promise<string> }).__e2eAnswer)) as T;
}
