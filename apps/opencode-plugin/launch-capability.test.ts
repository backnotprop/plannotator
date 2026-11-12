import { expect, test } from "bun:test";
import path from "node:path";
import { OPENCODE_LAUNCH_ENV } from "@plannotator/shared/inbox/opencode-launch";

test("the plugin's server bundle carries the launch env, which the Inbox reads in an installed copy to offer New OpenCode session", async () => {
  const built = await Bun.build({ entrypoints: [path.join(import.meta.dir, "server.ts")], target: "node", external: ["@opencode/plugin"] });
  expect(built.success).toBe(true);
  const text = (await Promise.all(built.outputs.map((output) => output.text()))).join("\n");
  expect(text).toContain(OPENCODE_LAUNCH_ENV);
}, 60_000);
