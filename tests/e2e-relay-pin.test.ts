import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEAD_RELAY, unpinnedE2eEnvs, unpinnedInboxEnvs } from "./helpers/relay-pin-scan";

const root = join(import.meta.dir, "..");

describe("no browser spec reaches the hosted relay", () => {
  test("every Inbox env a spec builds pins PLANNOTATOR_RELAY_URL or spreads process.env", () => {
    const unpinned = unpinnedE2eEnvs(root);
    if (unpinned.length > 0) {
      throw new Error(
        `These Inbox envs would reach https://relay.plannotator.ai. Add PLANNOTATOR_RELAY_URL: '${DEAD_RELAY}' next to PLANNOTATOR_DATA_DIR:\n${unpinned.join("\n")}`,
      );
    }
  });

  test("specs that spread process.env get the pin from the Playwright config and global setup", () => {
    for (const file of ["tests/e2e/playwright.config.ts", "tests/e2e/global-setup.ts"]) {
      expect(readFileSync(join(root, file), "utf8")).toContain(`process.env.PLANNOTATOR_RELAY_URL ??= '${DEAD_RELAY}'`);
    }
  });

  test("the scan flags a clean env and passes a pinned or spreading one", () => {
    expect(unpinnedInboxEnvs("const env = { PATH: p, HOME: h, PLANNOTATOR_DATA_DIR: d };")).toHaveLength(1);
    expect(unpinnedInboxEnvs("const env = {\n  HOME: h,\n  PLANNOTATOR_DATA_DIR: d,\n};\nconst other = { PLANNOTATOR_DATA_DIR: e };")).toHaveLength(2);
    expect(unpinnedInboxEnvs(`const env = { HOME: h, PLANNOTATOR_RELAY_URL: '${DEAD_RELAY}', PLANNOTATOR_DATA_DIR: d };`)).toHaveLength(0);
    expect(unpinnedInboxEnvs("const env = { ...process.env, PLANNOTATOR_DATA_DIR: d };")).toHaveLength(0);
    expect(unpinnedInboxEnvs("const env = { HOME: h, nested: { x: 1 }, PLANNOTATOR_DATA_DIR: d };")).toHaveLength(1);
  });
});
