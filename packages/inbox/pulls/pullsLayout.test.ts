/**
 * The Pull requests pages' layout under the worst case (break-ui on #2590), read from inbox.css (comments stripped),
 * as softGround.test.ts reads it. What regresses:
 *  - a long PR title in the review header pushing Back, the comments button and the verdict out of the window
 *    (the title must give way: shrinkable, min-width 0, cut with an ellipsis; the controls must not shrink);
 *  - a long agent session label widening its pill past the hand-off line (bounded, its label cut);
 *  - a long, unbroken branch name in a layer's line overflowing a phone's width.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CODE = readFileSync(join(import.meta.dir, '..', 'inbox.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');

/** The declarations of every rule whose selector list names `selector` exactly, joined. */
function declared(selector: string): string {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(CODE); m; m = re.exec(CODE)) {
    if (m[1]!.split(',').map((s) => s.trim()).includes(selector)) out.push(m[2]!);
  }
  return out.join(';');
}

test('the review header: the title gives way (shrinks, cut with "…"); Back and the verdict never shrink', () => {
  const title = declared('.ib-review .ib-vhead .ib-prr-fn');
  expect(title).toMatch(/flex:\s*0 1 auto/);
  expect(title).toMatch(/min-width:\s*0/);
  expect(declared('.ib-prr-fn bdi')).toMatch(/text-overflow:\s*ellipsis/);
  const back = declared('.pn-inbox .ib-prreview .ib-vhead .ib-back');
  expect(back).toMatch(/flex:\s*none/);
  expect(back).toMatch(/white-space:\s*nowrap/);
});

test("an agent pill is never wider than its line; its label is cut", () => {
  expect(declared('.pn-inbox .ib-pr-agbtn')).toMatch(/max-width:\s*100%/);
  const label = declared('.ib-pr-agbtn-t');
  expect(label).toMatch(/min-width:\s*0/);
  expect(label).toMatch(/text-overflow:\s*ellipsis/);
});

test('a long branch name in a layer line, or in a notice, wraps anywhere', () => {
  expect(declared('.ib-pr-basew')).toMatch(/overflow-wrap:\s*anywhere/);
  expect(declared('.ib-pr-notice')).toMatch(/overflow-wrap:\s*anywhere/);
});
