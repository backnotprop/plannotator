/** The Inbox keep-place table in Chromium: see `inbox-keep-place.cases.ts`. */

import { CASES, inboxWorld, runCase, runScrollCases } from './inbox-keep-place.cases';

const world = inboxWorld();
for (const entry of CASES) runCase(world, entry);
runScrollCases(world);
