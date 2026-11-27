/**
 * The launch switch's site file (public/launch.json, served as https://plannotator.ai/launch.json): every released app
 * reads it with packages/shared/launch-switch.ts's strict parser, and anything that parser refuses is off. What
 * regresses: a flip that a typo turns into a silent off (or a file the apps cannot read at all) reaching the site.
 *
 * Flipping it on: merge the "on" file the evening before, at least 3 hours before its startsAt plus one full Test run
 * on main (this path selects the whole suite, this file included, and the site deploys only after it passes). An app
 * whose last check said off asks again only after 3 hours (launch-switch.ts `launchRefreshMs`), and the dialog becomes due at startsAt from the copy
 * each app kept, with no request. Launch-day checklist: "The launch switch" in docs/agent-guides/guides-and-shared-ui.md.
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
