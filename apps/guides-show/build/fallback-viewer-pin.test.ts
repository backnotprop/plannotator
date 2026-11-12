import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

test('the fallback pin is still v0.28.36’s published viewer', () => {
  const pin = JSON.parse(readFileSync(path.join(import.meta.dirname, 'fallback-viewer-pin.json'), 'utf8'));
  expect(pin).toEqual({
    release: 'v0.28.36',
    js: 'viewer.C4IxWdQK.js',
    css: 'viewer.ar3IkrTA.css',
    jsIntegrity: 'sha384-/CN5/b1UaCPABarntRCUXuoteCDyOFWmVKIH89L7OkP+C4SZpr+hjB2s0jxwcGsT',
    cssIntegrity: 'sha384-rfwMLk0stnSlvTmukoNd6MUtn6ZzzWIurpSZLexgtBM97W25ST/Z1WaMxJwpfvP/',
  });
});
