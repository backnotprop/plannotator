// The verifier's compare mode decides whether a rebuilt Inbox may replace today's: these guard that decision.
import { describe, expect, test } from "bun:test";
import { compare, judgeStat, type Stat, type Suite } from "./inbox-live-verify";

const ms = (median: number, p95: number): Stat => ({ unit: "ms", samples: [], median, p95 });
const suite = (rules: Record<string, boolean>, stats: Record<string, Stat>): Suite => ({
  meta: {},
  runs: {
    "10k/local": {
      meta: { size: "10k", profile: "local" },
      rules: Object.fromEntries(Object.entries(rules).map(([id, pass]) => [id, { id, title: id, pass }])),
      stats,
    },
  },
});

describe("compare", () => {
  test("a live rule that passed and now fails is a regression, and the run fails", () => {
    const c = compare(suite({ "LV-01": true }, {}), suite({ "LV-01": false }, {}));
    expect(c.regressions).toEqual(["10k/local LV-01 regressed"]);
  });

  test("a rule that failed in the baseline and now passes is a fix, never a regression", () => {
    const c = compare(suite({ "LV-17": false }, {}), suite({ "LV-17": true }, {}));
    expect(c.regressions).toEqual([]);
    expect(c.lines.join("\n")).toContain("| fixed |");
  });

  test("a rule the new build no longer runs counts as a regression: a rebuild cannot pass by dropping a check", () => {
    const c = compare(suite({ "LV-09": true }, {}), suite({}, {}));
    expect(c.regressions).toEqual(["10k/local LV-09 missing"]);
  });

  test("event-to-paint slower past the tolerance is a regression; run-to-run noise is not", () => {
    expect(judgeStat(ms(100, 160), ms(130, 200))).toBe("same");
    expect(judgeStat(ms(100, 160), ms(150, 200))).toBe("worse");
    expect(judgeStat(ms(100, 160), ms(110, 400))).toBe("worse");
    expect(judgeStat(ms(400, 600), ms(200, 300))).toBe("better");
    const c = compare(suite({}, { agentMsgToOpenThreadSecondTab: ms(100, 160) }), suite({}, { agentMsgToOpenThreadSecondTab: ms(300, 500) }));
    expect(c.regressions).toEqual(["10k/local agentMsgToOpenThreadSecondTab worse"]);
  });

  test("more requests per agent message is a regression once past one extra request", () => {
    const n = (median: number): Stat => ({ unit: "count", samples: [], median, p95: median });
    expect(judgeStat(n(4), n(5))).toBe("same");
    expect(judgeStat(n(4), n(7))).toBe("worse");
  });
});
