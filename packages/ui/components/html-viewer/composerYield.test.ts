/**
 * Composer-yield hysteresis contract: the composer fades as the pointer
 * approaches (~near), goes click-through when over, and does NOT fully
 * restore until the pointer has moved well away (48px past the rect) or the
 * state machine is reset — preventing flicker at the borders.
 */
import { describe, expect, test } from "bun:test";
import {
  COMPOSER_YIELD_NEAR_ENTER_PX,
  COMPOSER_YIELD_NEAR_EXIT_PX,
  COMPOSER_YIELD_OVER_EXIT_PX,
  computeComposerYield,
  distanceToRect,
} from "./composerYield";

const RECT = { left: 100, top: 100, right: 300, bottom: 200 };

describe("distanceToRect", () => {
  test("inside is 0; outside is the shortest edge distance", () => {
    expect(distanceToRect(150, 150, RECT)).toBe(0);
    expect(distanceToRect(100, 100, RECT)).toBe(0); // on the corner
    expect(distanceToRect(50, 150, RECT)).toBe(50); // straight left
    expect(distanceToRect(150, 40, RECT)).toBe(60); // straight above
    expect(distanceToRect(70, 60, RECT)).toBe(50); // 30-40-50 diagonal corner
  });
});

describe("computeComposerYield", () => {
  test("far pointer stays none; approaching enters near; over the rect goes over", () => {
    expect(computeComposerYield("none", COMPOSER_YIELD_NEAR_ENTER_PX + 1)).toBe("none");
    expect(computeComposerYield("none", COMPOSER_YIELD_NEAR_ENTER_PX)).toBe("near");
    expect(computeComposerYield("near", 10)).toBe("near");
    expect(computeComposerYield("near", 0)).toBe("over");
    expect(computeComposerYield("none", 0)).toBe("over");
  });

  test("hysteresis: over holds until the pointer clears the exit band", () => {
    expect(computeComposerYield("over", COMPOSER_YIELD_OVER_EXIT_PX)).toBe("over");
    expect(computeComposerYield("over", COMPOSER_YIELD_OVER_EXIT_PX + 1)).toBe("near");
    expect(computeComposerYield("over", COMPOSER_YIELD_NEAR_EXIT_PX + 1)).toBe("none");
  });

  test("hysteresis: near exits later than it enters (no flicker at the border)", () => {
    const betweenEnterAndExit = COMPOSER_YIELD_NEAR_ENTER_PX + 5;
    expect(betweenEnterAndExit).toBeLessThanOrEqual(COMPOSER_YIELD_NEAR_EXIT_PX);
    expect(computeComposerYield("none", betweenEnterAndExit)).toBe("none"); // not yet entered
    expect(computeComposerYield("near", betweenEnterAndExit)).toBe("near"); // but doesn't drop out
    expect(computeComposerYield("near", COMPOSER_YIELD_NEAR_EXIT_PX + 1)).toBe("none");
  });
});
