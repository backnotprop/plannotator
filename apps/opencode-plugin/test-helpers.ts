import type { ToolContext } from "@opencode-ai/plugin";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlannotatorCliVerdict } from "./tool-helpers";

const tempDirs: string[] = [];

export function createToolContext(sessionID = "session-1"): ToolContext {
  return {
    sessionID,
    messageID: "message-1",
    agent: "build",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  };
}

export function createPromptCollector() {
  const prompts: Array<{
    path: { id: string };
    body: { agent?: string; noReply?: boolean; parts: Array<{ type: "text"; text: string }> };
  }> = [];
  return {
    prompts,
    client: {
      session: {
        async prompt(request: typeof prompts[number]) {
          prompts.push(request);
          return {};
        },
      },
    },
  };
}

export async function createTempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "plannotator-opencode-plugin-"));
  tempDirs.push(root);
  return root;
}

export async function cleanupTempDirs(): Promise<void> {
  const dirs = tempDirs.splice(0);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
}

export async function createMockCliEntrypoint(dir: string): Promise<string> {
  const scriptPath = join(dir, "mock-cli.ts");
  const scriptContent = [
    "const verdict = process.env.PLANNOTATOR_MOCK_STDOUT ?? '{\"approved\":true,\"mode\":\"plan\"}';",
    "process.stdout.write(verdict);",
    "process.exit(0);",
  ].join("\n");
  await writeFile(scriptPath, scriptContent);
  return scriptPath;
}

export function mockVerdictEnv(verdict: PlannotatorCliVerdict): string {
  const fields = [
    `"approved":${verdict.approved}`,
    verdict.cancelled === undefined ? null : `"cancelled":${verdict.cancelled}`,
    verdict.feedback === undefined ? null : `"feedback":${quoteJsonString(verdict.feedback)}`,
    `"mode":${quoteJsonString(verdict.mode)}`,
    verdict.agentSwitch === undefined ? null : `"agentSwitch":${quoteJsonString(verdict.agentSwitch)}`,
    verdict.permissionMode === undefined
      ? null
      : `"permissionMode":${quoteJsonString(verdict.permissionMode)}`,
  ].filter((field): field is string => field !== null);
  return `{${fields.join(",")}}`;
}

export async function withMockCli(
  verdict: PlannotatorCliVerdict,
  fn: (harness: ReturnType<typeof createPromptCollector> & { directory: string }) => Promise<void>,
): Promise<void> {
  const directory = await createTempDir();
  const mockEntrypoint = await createMockCliEntrypoint(directory);
  const collector = createPromptCollector();
  await withEnv(
    {
      PLANNOTATOR_CLI_ENTRYPOINT: mockEntrypoint,
      PLANNOTATOR_MOCK_STDOUT: mockVerdictEnv(verdict),
    },
    async () => fn({ ...collector, directory }),
  );
}

export function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const keys = Object.keys(vars);
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) {
    saved[key] = process.env[key];
  }
  for (const key of keys) {
    const value = vars[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return fn().finally(() => {
    for (const key of keys) {
      const value = saved[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

function quoteJsonString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")}"`;
}
