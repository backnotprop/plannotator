/**
 * `CreateSessionOptions.oneShot` (the Inbox's PR risk agent): what the providers tell their agent CLIs. What regresses:
 * a background judgment getting tools, the person's settings or a saved session; Pi's default model being rewritten.
 * Each CLI here is a scratch script: no test runs a real agent.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAgentSDKProvider } from "./providers/claude-agent-sdk.ts";
import { codexOneShotConfigArgs } from "./providers/ask-ai-env.ts";
import { CodexAppServerProvider, codexOneShotToolUse } from "./providers/codex-app-server.ts";
import { PiSDKProvider, piOneShotArgs } from "./providers/pi-sdk.ts";
import type { AIMessage, AISession } from "./types.ts";

const dir = mkdtempSync(join(tmpdir(), "plannotator-one-shot-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const context = { mode: "plan-review", plan: { plan: "# Plan" } } as const;
const drain = async (session: AISession) => {
  for await (const _ of session.query("hello")) void _;
};

function script(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

describe("Claude", () => {
  /** The flags the SDK started `claude` with, and what it wrote to its stdin (the system prompt goes there). */
  const startOf = async (oneShot: { systemPrompt: string } | undefined) => {
    const name = Math.random().toString(36).slice(2);
    const log = join(dir, `claude-${name}.txt`);
    const path = script(`claude-${name}`, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done\nhead -n 1 >> '${log}.in'\nexit 1\n`);
    const provider = new ClaudeAgentSDKProvider({ type: "claude-agent-sdk", cwd: dir, claudeExecutablePath: path, allowedTools: [] });
    await drain(await provider.createSession({ context, ...(oneShot ? { oneShot } : {}) }));
    return { argv: readFileSync(log, "utf8").split("\n"), stdin: existsSync(`${log}.in`) ? readFileSync(`${log}.in`, "utf8") : "" };
  };

  test.skipIf(process.platform === "win32")("no tools, only its own prompt, no hooks, no MCP servers, no saved session; settings load, so it routes where the person set it up", async () => {
    const { argv, stdin } = await startOf({ systemPrompt: "JUDGE" });
    expect(argv.some((a) => a === "--tools=" || a === "--tools")).toBe(true);
    // Bedrock or Vertex set in settings.json: without them, a diff would go to whatever login this Claude has.
    expect(argv.some((a) => a.startsWith("--setting-sources"))).toBe(false);
    expect(JSON.parse(argv[argv.indexOf("--settings") + 1]!)).toEqual({ disableAllHooks: true });
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("--no-session-persistence");
    expect(JSON.parse(stdin).request.systemPrompt).toEqual(["JUDGE"]);
    expect(stdin).not.toContain("appendSystemPrompt");
  }, 15_000);

  test.skipIf(process.platform === "win32")("Ask AI's own sessions are as they were", async () => {
    const { argv, stdin } = await startOf(undefined);
    expect(argv.some((a) => a.startsWith("--tools"))).toBe(false);
    expect(argv.some((a) => a.startsWith("--setting-sources"))).toBe(false);
    expect(argv).not.toContain("--no-session-persistence");
    expect(argv).not.toContain("--strict-mcp-config");
    expect(stdin).toContain("appendSystemPrompt");
  }, 15_000);
});

describe("Pi", () => {
  /** A `pi` in Bun's own runner: it keeps its argv and what it was sent, answers each command, and ends a prompt at once. */
  const fakePi = () => {
    const log = join(dir, `pi-${Math.random().toString(36).slice(2)}.jsonl`);
    const path = script(
      `pi-${Math.random().toString(36).slice(2)}`,
      `#!/bin/sh
exec ${JSON.stringify(process.execPath)} -e '
const fs=require("fs");const log=${JSON.stringify(log)};
fs.appendFileSync(log,JSON.stringify({argv:process.argv.slice(1)})+"\\n");
require("readline").createInterface({input:process.stdin}).on("line",(l)=>{
  const m=JSON.parse(l);fs.appendFileSync(log,l+"\\n");
  process.stdout.write(JSON.stringify({type:"response",id:m.id,command:m.type,success:true,data:{}})+"\\n");
  if(m.type==="prompt")process.stdout.write(JSON.stringify({type:"agent_end"})+"\\n");
})' -- "$@"
`,
    );
    return { path, sent: () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) };
  };

  test.skipIf(process.platform === "win32")("no tools, no session, none of the person's extensions or context files; the model by flag, never set_model, which rewrote the person's default on older pi", async () => {
    const pi = fakePi();
    const provider = new PiSDKProvider({ type: "pi-sdk", cwd: dir, piExecutablePath: pi.path });
    const session = await provider.createSession({ context, model: "anthropic/claude-sonnet-5", reasoningEffort: "low", oneShot: { systemPrompt: "JUDGE" } });
    await drain(session);
    provider.dispose();
    const sent = pi.sent();
    const argv = sent[0]!.argv as string[];
    expect(argv.join(" ")).toContain("--mode rpc --no-tools --no-session --no-extensions --no-skills --no-context-files --provider anthropic --model claude-sonnet-5 --thinking low");
    expect(sent.map((m) => m.type)).not.toContain("set_model");
    expect(sent.map((m) => m.type)).not.toContain("set_thinking_level");
    expect(sent.find((m) => m.type === "prompt")!.message).toStartWith("JUDGE");
  }, 15_000);

  test.skipIf(process.platform === "win32")("Ask AI's own sessions are as they were", async () => {
    const pi = fakePi();
    const provider = new PiSDKProvider({ type: "pi-sdk", cwd: dir, piExecutablePath: pi.path });
    await drain(await provider.createSession({ context, model: "anthropic/claude-sonnet-5" }));
    provider.dispose();
    const sent = pi.sent();
    expect((sent[0]!.argv as string[]).join(" ")).not.toContain("--no-tools");
    expect(sent.map((m) => m.type)).toContain("set_model");
  }, 15_000);

  test("a model with no provider part isn't guessed at", () => {
    expect(piOneShotArgs("sonnet", undefined)).not.toContain("--model");
  });

  test("with no effort named, it thinks low, not at the person's default", () => {
    const args = piOneShotArgs("anthropic/claude-sonnet-5", undefined);
    expect(args.slice(args.indexOf("--thinking"))).toEqual(["--thinking", "low"]);
  });
});

describe("Codex", () => {
  const params = async (oneShot: boolean) => {
    const provider = new CodexAppServerProvider({ type: "codex-sdk", cwd: dir, codexExecutablePath: "/nonexistent" });
    const session = await provider.createSession({ context, ...(oneShot ? { oneShot: { systemPrompt: "JUDGE" } } : {}) });
    return (session as unknown as { threadStartParams(): { params: Record<string, unknown> } }).threadStartParams().params;
  };
  test("a judgment's thread isn't kept, and the sandbox stays read-only either way", async () => {
    expect(await params(true)).toMatchObject({ sandbox: "read-only", ephemeral: true });
    const normal = await params(false);
    expect(normal.sandbox).toBe("read-only");
    expect(normal.ephemeral).toBeUndefined();
  });

  test.each([["mcpToolCall"], ["webSearch"], ["dynamicToolCall"], ["fileChange"], ["collabAgentToolCall"], ["imageView"], ["a kind nobody has named yet"]])("an item of %s counts as a tool use", (type) => {
    expect(codexOneShotToolUse({ method: "item/started", params: { item: { type, id: "i" } } })?.type).toBe("tool_use");
  });

  test.each([["userMessage"], ["agentMessage"], ["reasoning"]])("an item of %s is plain writing", (type) => {
    expect(codexOneShotToolUse({ method: "item/started", params: { item: { type, id: "i" } } })).toBeNull();
    expect(codexOneShotToolUse({ method: "item/completed", params: { item: { type: "mcpToolCall", id: "i" } } })).toBeNull();
  });

  test("web search goes off, and each MCP server the config names, once", () => {
    const args = codexOneShotConfigArgs(['[mcp_servers.slack]\ncommand = "x"\n[mcp_servers.slack.env]\nA = "1"\n', '  [mcp_servers."linear-1"]\nurl = "y"\n[other]\n']);
    expect(args).toEqual(["-c", "web_search='disabled'", "-c", "mcp_servers.slack.enabled=false", "-c", "mcp_servers.linear-1.enabled=false"]);
  });

  /** A `codex` that answers every request, then does what the test says in the turn. */
  const fakeCodex = (turn: string) => {
    const log = join(dir, `codex-${Math.random().toString(36).slice(2)}.txt`);
    const path = script(
      `codex-${Math.random().toString(36).slice(2)}`,
      `#!/bin/sh
exec ${JSON.stringify(process.execPath)} -e '
const fs=require("fs");fs.writeFileSync(${JSON.stringify(log)},process.argv.slice(1).join(" "));
const out=(m)=>process.stdout.write(JSON.stringify(m)+"\\n");
require("readline").createInterface({input:process.stdin}).on("line",(l)=>{
  const m=JSON.parse(l);if(m.id===undefined||m.method===undefined)return;
  if(m.method==="thread/start")return out({id:m.id,result:{thread:{id:"th"}}});
  if(m.method==="turn/start"){out({id:m.id,result:{turn:{id:"tu"}}});${turn}return;}
  out({id:m.id,result:{}});
})' -- "$@"
`,
    );
    return { path, argv: () => readFileSync(log, "utf8") };
  };
  const messagesOf = async (path: string, oneShot: boolean) => {
    const provider = new CodexAppServerProvider({ type: "codex-sdk", cwd: dir, codexExecutablePath: path });
    const session = await provider.createSession({ context, ...(oneShot ? { oneShot: { systemPrompt: "JUDGE" } } : {}) });
    const messages: AIMessage[] = [];
    for await (const message of session.query("hello")) {
      messages.push(message);
      if (message.type === "tool_use" || message.type === "permission_request" || message.type === "result") break;
    }
    session.dispose?.();
    provider.dispose();
    return messages;
  };
  const events = (first: string) => `out(${first});out({method:"turn/completed",params:{threadId:"th",turn:{id:"tu",status:"completed"}}});`;

  test.skipIf(process.platform === "win32")("through a running session: an MCP call stops a judgment, and only a judgment; web search is off on its command line", async () => {
    const mcp = fakeCodex(events(`{method:"item/started",params:{threadId:"th",turnId:"tu",item:{type:"mcpToolCall",id:"i",server:"slack",tool:"post"}}}`));
    expect((await messagesOf(mcp.path, true)).map((m) => m.type)).toContain("tool_use");
    expect(mcp.argv()).toContain("web_search='disabled'");
    const normal = fakeCodex(events(`{method:"item/started",params:{threadId:"th",turnId:"tu",item:{type:"mcpToolCall",id:"i",server:"slack",tool:"post"}}}`));
    expect((await messagesOf(normal.path, false)).map((m) => m.type)).not.toContain("tool_use");
    expect(normal.argv()).not.toContain("web_search");
  }, 20_000);

  test.skipIf(process.platform === "win32")("any request Codex makes of a judgment ends it", async () => {
    const asks = fakeCodex(events(`{id:99,method:"item/tool/requestUserInput",params:{threadId:"th",turnId:"tu"}}`));
    expect((await messagesOf(asks.path, true)).map((m) => m.type)).toContain("permission_request");
  }, 20_000);
});
