/**
 * The fallback viewer pin is what every checkout that has not built the viewer
 * (and any build that skipped `build:viewer-pin`) pins into exports. It must be
 * a viewer guides.show already serves: v0.28.36's, checked live (HEAD 200, SRI
 * equal to the served bytes) when it was chosen. Published viewer files are
 * immutable, so it never has to change, and a change is a mistake: typically a
 * merge of a branch that still edits the old committed manifest, which git can
 * pair with this file. Values frozen on purpose.
 */
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
