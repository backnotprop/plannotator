import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleCliCommand } from "./cli-bridge";
import type { SessionBridge } from "@plannotator/ai/session-bridge";

const AI_INDEX = path.join(import.meta.dir, "..", "..", "packages", "ai", "index.ts");

describe("Ask this session through the CLI child (pull bridge)", () => {
  // The CLI runs as a separate process, so the only way a question reaches the
  // OpenCode session is: the plugin hands the child a token, learns its port
  // from the ready file, and long-polls it. This stub CLI is a real pull-bridge
  // server that asks one question and records the answer it gets back.
  test.skipIf(process.platform === "win32")("the plugin answers the child's question from the invoking session", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "plannotator-opencode-bridge-"));
    const binary = path.join(root, "cli.ts");
    const out = path.join(root, "out.json");
    const doc = path.join(root, "notes.md");
    writeFileSync(doc, "# Notes\n");
    writeFileSync(binary, `#!/usr/bin/env bun
import { appendFileSync, writeFileSync } from "node:fs";
import { createPullSessionBridge, takePullSessionBridgeConfig, SessionBridgeProvider } from ${JSON.stringify(AI_INDEX)};
const config = takePullSessionBridgeConfig(process.env);
if (!config) {
  writeFileSync(${JSON.stringify(out)}, JSON.stringify({ config: null }));
  console.log(JSON.stringify({ decision: "dismissed" }));
  process.exit(0);
}
const pull = createPullSessionBridge(config);
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => pull.handle(req) ?? new Response("nf", { status: 404 }) });
appendFileSync(process.env.PLANNOTATOR_READY_FILE, JSON.stringify({ url: "http://localhost:" + server.port, isRemote: false, port: server.port }) + "\\n");
const provider = new SessionBridgeProvider(pull.bridge);
const session = await provider.createSession({ context: { mode: "annotate", annotate: { content: "# Notes", filePath: "notes.md" } } });
const messages = [];
for await (const message of session.query("What is this file?")) messages.push(message);
writeFileSync(${JSON.stringify(out)}, JSON.stringify({ config: { host: config.host, modes: config.modes, tokenLength: config.token.length }, tokenLeft: process.env.PLANNOTATOR_SESSION_BRIDGE_TOKEN ?? null, messages }));
pull.dispose();
server.stop(true);
console.log(JSON.stringify({ decision: "dismissed" }));
`, { mode: 0o755 });

    const asked: string[] = [];
    const dispose = mock(() => {});
    const hostBridge: SessionBridge & { dispose: () => void } = {
      host: "opencode",
      modes: { turn: true, transient: true },
      status: () => "ready",
      ask(req, sink) {
        asked.push(req.text);
        setTimeout(() => {
          sink.delta("A notes ");
          sink.delta("file.");
          sink.done("A notes file.");
        }, 5);
      },
      dispose,
    };
    const client = {
      app: { log: mock((_entry: { message: string }) => {}) },
      session: { prompt: mock(async (_input: unknown) => ({})) },
    };
    const previous = process.env.PLANNOTATOR_BIN;
    try {
      process.env.PLANNOTATOR_BIN = binary;
      await handleCliCommand({
        command: "plannotator-annotate",
        client,
        sessionId: "ses_1",
        cwd: root,
        rawArgs: doc,
        createSessionBridge: () => hostBridge,
      });
      const result = JSON.parse(readFileSync(out, "utf-8"));
      expect(result.config).toEqual({ host: "opencode", modes: { turn: true, transient: true }, tokenLength: 43 });
      // The child scrubs the token so nothing it spawns inherits it.
      expect(result.tokenLeft).toBeNull();
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain("What is this file?");
      const text = result.messages.filter((m: any) => m.type === "text_delta").map((m: any) => m.delta).join("");
      expect(text).toBe("A notes file.");
      expect(result.messages.at(-1)).toMatchObject({ type: "result", result: "A notes file." });
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) delete process.env.PLANNOTATOR_BIN;
      else process.env.PLANNOTATOR_BIN = previous;
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test.skipIf(process.platform === "win32")("without a bridge the child gets no token", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "plannotator-opencode-nobridge-"));
    const binary = path.join(root, "cli.ts");
    const out = path.join(root, "out.json");
    const doc = path.join(root, "notes.md");
    writeFileSync(doc, "# Notes\n");
    writeFileSync(binary, `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(out)}, JSON.stringify({ token: process.env.PLANNOTATOR_SESSION_BRIDGE_TOKEN ?? null }));
console.log(JSON.stringify({ decision: "dismissed" }));
`, { mode: 0o755 });
    const client = { app: { log: mock((_entry: { message: string }) => {}) }, session: { prompt: mock(async () => ({})) } };
    const previous = process.env.PLANNOTATOR_BIN;
    try {
      process.env.PLANNOTATOR_BIN = binary;
      await handleCliCommand({ command: "plannotator-annotate", client, sessionId: "ses_1", cwd: root, rawArgs: doc });
      expect(JSON.parse(readFileSync(out, "utf-8"))).toEqual({ token: null });
    } finally {
      if (previous === undefined) delete process.env.PLANNOTATOR_BIN;
      else process.env.PLANNOTATOR_BIN = previous;
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
