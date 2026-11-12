import { createFenceMarkup, type FenceMarkupRequest } from './fenceMarkup';

const make = createFenceMarkup();

self.addEventListener('message', (event: MessageEvent<FenceMarkupRequest>) => {
  void make(event.data).then((reply) => self.postMessage(reply));
});
