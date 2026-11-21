/**
 * The Inbox's highlight worker: makes the markup of code fences waiting off screen (fenceMarkup.ts), so their
 * tokens are not made on the page. Started by codeHighlightWorker.ts, built inline by Vite (`?worker&inline`).
 */
import { createFenceMarkup, type FenceMarkupRequest } from './fenceMarkup';

const make = createFenceMarkup();

self.addEventListener('message', (event: MessageEvent<FenceMarkupRequest>) => {
  void make(event.data).then((reply) => self.postMessage(reply));
});
