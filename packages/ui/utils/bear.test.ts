import { describe, expect, test } from "bun:test";
import { normalizeTags } from "./bear";

describe("normalizeTags", () => {
  test("basic comma-separated tags", () => {
    expect(normalizeTags("plan, work")).toBe("plan, work");
  });

  test("strips # prefix", () => {
    expect(normalizeTags("#plan, ##work")).toBe("plan, work");
  });

  test("lowercases", () => {
    expect(normalizeTags("Plan, WORK")).toBe("plan, work");
  });

  test("replaces spaces with hyphens", () => {
    expect(normalizeTags("my plan, some work")).toBe("my-plan, some-work");
  });

  test("preserves slashes for Bear nested tags", () => {
    expect(normalizeTags("plannotator/plans")).toBe("plannotator/plans");
  });

  test("preserves deep nested tags", () => {
    expect(normalizeTags("work/projects/frontend")).toBe("work/projects/frontend");
  });

  test("mixed nested and flat tags", () => {
    expect(normalizeTags("plannotator/plans, work, code/review")).toBe("plannotator/plans, work, code/review");
  });

  test("collapses consecutive slashes", () => {
    expect(normalizeTags("work//plans")).toBe("work/plans");
  });

  test("strips leading/trailing slashes", () => {
    expect(normalizeTags("/work/plans/")).toBe("work/plans");
  });

  test("filters empty segments", () => {
    expect(normalizeTags(",, plan")).toBe("plan");
  });
});
