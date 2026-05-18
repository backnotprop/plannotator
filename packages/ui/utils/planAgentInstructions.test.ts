import { describe, expect, test } from "bun:test";
import { buildPlanAgentInstructions } from "./planAgentInstructions";

describe("buildPlanAgentInstructions", () => {
  test("uses the provided API base instead of assuming root /api routes", () => {
    const instructions = buildPlanAgentInstructions("http://localhost:1234/s/s1/api");

    expect(instructions).toContain("curl -s http://localhost:1234/s/s1/api/plan");
    expect(instructions).toContain("http://localhost:1234/s/s1/api/external-annotations");
    expect(instructions).not.toContain("/s/s1/api/api/");
  });
});
