import { describe, expect, test } from "bun:test";
import { classicPlanReviewOrphaned } from "./orphan-plan-review";

const HOOK = { hostResultFile: false, stdoutPiped: true, startPpid: 4242 };

describe("classicPlanReviewOrphaned", () => {
  test("a hook review whose parent is still there keeps running", () => {
    expect(classicPlanReviewOrphaned({ ...HOOK, currentPpid: 4242 })).toBe(false);
  });

  test("a hook review exits once it is reparented to init or a subreaper", () => {
    expect(classicPlanReviewOrphaned({ ...HOOK, currentPpid: 1 })).toBe(true);
    expect(classicPlanReviewOrphaned({ ...HOOK, currentPpid: 777 })).toBe(true);
  });

  test("a launch with a host result file never exits for its parent", () => {
    expect(classicPlanReviewOrphaned({ ...HOOK, hostResultFile: true, currentPpid: 1 })).toBe(false);
  });

  test("stdout to a file or terminal (nohup) never exits for its parent", () => {
    expect(classicPlanReviewOrphaned({ ...HOOK, stdoutPiped: false, currentPpid: 1 })).toBe(false);
  });

  test("a review started under PID 1, or with no parent pid, has no parent to lose", () => {
    expect(classicPlanReviewOrphaned({ ...HOOK, startPpid: 1, currentPpid: 1 })).toBe(false);
    expect(classicPlanReviewOrphaned({ ...HOOK, startPpid: 0, currentPpid: 1 })).toBe(false);
  });
});
