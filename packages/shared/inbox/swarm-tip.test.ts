/**
 * The Swarm tip's claim (swarm-tip.ts). What can regress: the card shown twice (on a second window, the phone, a later
 * day), a page that lost the answer not shown it again on its retry, or nothing stamped when it shows.
 */
import { expect, test } from "bun:test";
import { swarmTipClaim } from "./swarm-tip";

const AT = "2026-11-24T14:00:00.000Z";

test("the first claim shows it and stamps it with the page's key; any later claim gets no, the same key's retry yes", () => {
  const first = swarmTipClaim(undefined, "page-key-1", AT);
  expect(first).toEqual({ show: true, save: { shownAt: AT, key: "page-key-1" } });
  expect(swarmTipClaim(first.save!, "page-key-2", AT)).toEqual({ show: false, save: null });
  expect(swarmTipClaim(first.save!, null, AT)).toEqual({ show: false, save: null });
  expect(swarmTipClaim(first.save!, "page-key-1", AT)).toEqual({ show: true, save: null });
});
