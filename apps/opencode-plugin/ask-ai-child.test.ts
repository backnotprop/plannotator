import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import PlannotatorPlugin from "./index";
import serverPlugin from "./server";

const KEYS = ["PLANNOTATOR_ASK_AI_CHILD", "PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_TOOL", "PLANNOTATOR_AGENT_TOOL", "PLANNOTATOR_INBOX_CONNECT"] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
let dataDir = "";
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-opencode-ask-ai-"));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  process.env.PLANNOTATOR_INBOX_CONNECT = "0";
  delete process.env.PLANNOTATOR_INBOX_TOOL;
  delete process.env.PLANNOTATOR_AGENT_TOOL;
});
afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dataDir, { recursive: true, force: true });
});

function v2Context() {
  const registered: string[] = [];
  const context = {
    options: {},
    agent: { list: async () => ({ data: [] }), transform: async () => ({ dispose: async () => {} }) },
    session: {
      get: async () => ({}),
      hook: async (name: string) => {
        registered.push(`hook:${name}`);
        return { dispose: async () => {} };
      },
    },
    tool: {
      transform: async (callback: (draft: { add: (tool: { name: string }) => void }) => void) => {
        callback({ add: (tool) => registered.push(`tool:${tool.name}`) });
        return { dispose: async () => {} };
      },
    },
  };
  return { context, registered };
}

describe("the OpenCode plugin in an OpenCode Ask AI started", () => {
  test("OpenCode 2: setup registers no tool and no hook; without the marker it registers submit_plan", async () => {
    process.env.PLANNOTATOR_ASK_AI_CHILD = "1";
    const off = v2Context();
    await serverPlugin.setup(off.context as never);
    expect(off.registered).toEqual([]);

    delete process.env.PLANNOTATOR_ASK_AI_CHILD;
    const on = v2Context();
    const cleanup = await serverPlugin.setup(on.context as never);
    expect(on.registered).toContain("tool:submit_plan");
    if (typeof cleanup === "function") cleanup();
  });

  test("OpenCode 1: the plugin returns no hooks", async () => {
    process.env.PLANNOTATOR_ASK_AI_CHILD = "1";
    expect(await PlannotatorPlugin({ client: {}, directory: "/project" } as never, {} as never)).toEqual({});
  });
});
