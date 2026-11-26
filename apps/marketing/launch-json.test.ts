/**
 * The launch switch's site file (public/launch.json, served as https://plannotator.ai/launch.json): every released app
 * reads it with packages/shared/launch-switch.ts's strict parser, and anything that parser refuses is off. What
 * regresses: a flip that a typo turns into a silent off (or a file the apps cannot read at all) reaching the site.
 * The site lane runs this file on a push that changes only public/launch.json.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LAUNCH_SWITCH_MAX_BYTES, parseLaunchDoc } from '../../packages/shared/launch-switch';

const bytes = readFileSync(join(import.meta.dir, 'public', 'launch.json'));

describe('public/launch.json', () => {
  test('the shared parser reads it, under the size cap', () => {
    expect(bytes.byteLength).toBeLessThanOrEqual(LAUNCH_SWITCH_MAX_BYTES);
    const doc = parseLaunchDoc(new Uint8Array(bytes));
    expect(doc, 'the apps read this file as off: fix it before it deploys').not.toBeNull();
    expect(doc!.v).toBe(1);
  });
});
