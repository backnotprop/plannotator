/**
 * Antigravity provider — bridges Plannotator's AI layer with the Google Antigravity CLI / Language Server.
 *
 * Drives the installed `agy` CLI in headless streaming JSON mode (`--output-format stream-json`).
 * Reuses the user's active Google account and Gemini model selection with zero external API keys.
 * Inline chat runs in read-only / sandboxed mode for safety.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { BaseSession } from "../base-session.ts";
import { buildSystemPrompt } from "../context.ts";
import type {
  AIMessage,
  AIProvider,
  AIProviderCapabilities,
  AISession,
  AntigravityLSConfig,
  CreateSessionOptions,
} from "../types.ts";
import { registerProviderFactory } from "../provider.ts";
import {
  buildWindowsCommandScriptSpawnCommand,
  killWindowsProcessTree,
  resolveWindowsCommandShim,
} from "./command-path.ts";
import {
  ANTIGRAVITY_FALLBACK_MODELS,
  antigravityCatalogFromModels,
  cliVersionFrom,
  type CatalogModel,
  type ModelsSource,
} from "@plannotator/core/model-catalog";

const PROVIDER_NAME = "antigravity-ls";
const DEFAULT_MODEL = "gemini-3.8-flash-high";
const MODEL_DISCOVERY_TIMEOUT_MS = 15_000;

export class AntigravityLSProvider implements AIProvider {
  readonly name = PROVIDER_NAME;
  readonly capabilities: AIProviderCapabilities = {
    fork: false,
    resume: true,
    streaming: true,
    tools: false,
  };

  models: CatalogModel[] = [...ANTIGRAVITY_FALLBACK_MODELS];
  modelsSource: ModelsSource = "fallback";
  toolVersion?: string;

  readonly config: AntigravityLSConfig;

  constructor(config: AntigravityLSConfig) {
    this.config = config;
  }

  /** Resolve path to `agy` CLI executable. */
  resolveExecutablePath(): string | null {
    if (this.config.executablePath) {
      return resolveWindowsCommandShim(this.config.executablePath);
    }
    const envExe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
    if (envExe) {
      return resolveWindowsCommandShim(envExe);
    }
    const whichAgy = typeof Bun !== "undefined" ? Bun.which("agy") : null;
    if (whichAgy) {
      return resolveWindowsCommandShim(whichAgy);
    }
    return resolveWindowsCommandShim("agy");
  }

  /**
   * Populate `models` and `toolVersion` from the installed `agy` CLI.
   */
  async fetchModels(): Promise<void> {
    const exe = this.resolveExecutablePath() ?? "agy";

    // Concurrently probe version via `agy --version` and discover models via `agy models`
    const [versionRes, modelsRes] = await Promise.allSettled([
      new Promise<string>((resolve, reject) => {
        execFile(
          exe,
          ["--version"],
          { timeout: MODEL_DISCOVERY_TIMEOUT_MS },
          (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout);
          }
        );
      }),
      new Promise<string>((resolve, reject) => {
        execFile(
          exe,
          ["models"],
          { timeout: MODEL_DISCOVERY_TIMEOUT_MS },
          (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout);
          }
        );
      }),
    ]);

    if (versionRes.status === "fulfilled") {
      const parsedVersion = cliVersionFrom(versionRes.value);
      if (parsedVersion) {
        this.toolVersion = parsedVersion;
      }
    }

    if (modelsRes.status === "fulfilled") {
      const discovered = antigravityCatalogFromModels(modelsRes.value);
      if (discovered.length > 0) {
        this.models = discovered;
        this.modelsSource = "discovered";
      }
    }
  }

  async createSession(options: CreateSessionOptions): Promise<AISession> {
    return new AntigravityLSSession({
      provider: this,
      options,
    });
  }

  async forkSession(_options: CreateSessionOptions): Promise<AISession> {
    throw new Error(
      "Antigravity provider does not support forkSession. Use createSession() instead."
    );
  }

  async resumeSession(sessionId: string): Promise<AISession> {
    return new AntigravityLSSession({
      provider: this,
      options: {
        context: {
          mode: "plan-review",
          plan: { plan: "" },
        },
      },
      initialId: sessionId,
    });
  }

  dispose(): void {
    // No-op: processes are short-lived per-turn queries.
  }
}

export function buildAgyArgs(
  options: CreateSessionOptions,
  provider: AntigravityLSProvider,
  prompt: string,
  conversationId?: string | null
): string[] {
  const args: string[] = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
  ];

  if (conversationId) {
    args.push("--conversation", conversationId);
  }

  if (options.model) {
    args.push("--model", options.model);

    let effort = options.reasoningEffort?.trim() || "";
    if (effort === "auto") {
      effort = "";
    }
    if (!effort) {
      const catalogModel = provider.models.find((m) => m.id === options.model);
      if (catalogModel?.defaultReasoningEffort) {
        effort = catalogModel.defaultReasoningEffort;
      } else if (catalogModel?.reasoningEfforts && catalogModel.reasoningEfforts.length > 0) {
        effort = catalogModel.reasoningEfforts[0].id;
      } else if (options.model.startsWith("gemini-")) {
        effort = options.model.includes("pro") ? "high" : "medium";
      }
    }
    if (effort) {
      args.push("--effort", effort);
    }
  } else if (options.reasoningEffort && options.reasoningEffort !== "auto") {
    args.push("--effort", options.reasoningEffort.trim());
  }

  if (provider.config.sandbox !== false) {
    args.push("--sandbox");
  }

  // Ask AI is strictly a read-only assistant: enforce plan mode to disallow edits.
  args.push("--mode", "plan");

  return args;
}

interface SessionOpts {
  provider: AntigravityLSProvider;
  options: CreateSessionOptions;
  initialId?: string;
}

export class AntigravityLSSession extends BaseSession {
  private provider: AntigravityLSProvider;
  private options: CreateSessionOptions;
  private messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  private activeProc: ChildProcess | null = null;

  constructor(opts: SessionOpts) {
    super({
      parentSessionId: null,
      initialId: opts.initialId,
    });
    this.provider = opts.provider;
    this.options = opts.options;
    if (opts.initialId) {
      this._resolvedId = opts.initialId;
    }
  }

  override abort(): void {
    if (this.activeProc) {
      const pid = this.activeProc.pid;
      if (pid) {
        killWindowsProcessTree(pid);
      }
      try {
        this.activeProc.kill();
      } catch {
        // Process may already have terminated.
      }
      this.activeProc = null;
    }
    super.abort();
  }

  async *query(prompt: string): AsyncIterable<AIMessage> {
    const q = this.startQuery();
    if (!q) {
      yield BaseSession.BUSY_ERROR;
      return;
    }

    const conversationId = this._resolvedId;
    let effectivePrompt = prompt;
    if (!conversationId && !this._firstQuerySent) {
      const systemPrompt = buildSystemPrompt(this.options.context);
      effectivePrompt = `${systemPrompt}\n\nUser Question:\n${prompt}`;
      this._firstQuerySent = true;
    } else if (!conversationId && this.messages.length > 0) {
      const historyText = this.messages
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
        .join("\n\n");
      effectivePrompt = `Previous conversation:\n${historyText}\n\nUser: ${prompt}`;
    }

    this.messages.push({ role: "user", content: prompt });

    const exe = this.provider.resolveExecutablePath() ?? "agy";
    const args = buildAgyArgs(this.options, this.provider, effectivePrompt, conversationId);

    const command =
      buildWindowsCommandScriptSpawnCommand(exe, args) ?? [exe, ...args];

    const cwd = this.options.cwd ?? this.provider.config.cwd ?? process.cwd();

    let child: ChildProcess;
    try {
      child = spawn(command[0], command.slice(1), {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.activeProc = child;
    } catch (err) {
      this.endQuery(q.gen);
      yield {
        type: "error",
        error: `Failed to spawn Antigravity CLI (${exe}): ${err instanceof Error ? err.message : String(err)}`,
      };
      return;
    }

    const onAbort = () => {
      this.abort();
    };
    q.signal.addEventListener("abort", onAbort, { once: true });

    let fullResponse = "";
    let lineBuffer = "";
    let yieldedResult = false;
    let yieldedError = false;

    // Line reader queue
    const messageQueue: AIMessage[] = [];
    let resolveWait: (() => void) | null = null;
    let streamDone = false;

    const pushMessage = (msg: AIMessage) => {
      messageQueue.push(msg);
      if (resolveWait) {
        const r = resolveWait;
        resolveWait = null;
        r();
      }
    };

    const processLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.event === "init" && typeof parsed.conversation_id === "string") {
          this.resolveId(parsed.conversation_id);
        } else if (parsed.event === "step_update") {
          const update = parsed.step_update;
          if (
            update?.step_type === "agent_response" &&
            typeof update.text_delta === "string" &&
            update.text_delta
          ) {
            fullResponse += update.text_delta;
            pushMessage({ type: "text_delta", delta: update.text_delta });
          }
        } else if (parsed.event === "result") {
          const res = parsed.result;
          if (res?.status === "SUCCESS") {
            const finalAnswer = (typeof res.response === "string" && res.response) || fullResponse;
            yieldedResult = true;
            pushMessage({
              type: "result",
              sessionId: this.id,
              success: true,
              result: finalAnswer,
            });
          } else if (res?.status === "ERROR") {
            yieldedError = true;
            pushMessage({
              type: "error",
              error: (typeof res.error === "string" && res.error) || "Antigravity turn failed",
            });
          }
        }
      } catch {
        // Non-JSON line or log output; ignore.
      }
    };

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      lineBuffer += chunk;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        processLine(line);
      }
    });

    let stderrBuffer = "";
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      stderrBuffer += chunk;
    });

    child.on("close", (code) => {
      if (lineBuffer.trim()) {
        processLine(lineBuffer);
        lineBuffer = "";
      }

      if (code !== 0 && !yieldedResult && !yieldedError && !q.signal.aborted) {
        pushMessage({
          type: "error",
          error:
            stderrBuffer.trim() ||
            `Antigravity process exited with code ${code}`,
        });
      } else if (!yieldedResult && !yieldedError && !q.signal.aborted) {
        // Process finished cleanly without explicit result event
        pushMessage({
          type: "result",
          sessionId: this.id,
          success: true,
          result: fullResponse,
        });
      }

      streamDone = true;
      if (resolveWait) {
        const r = resolveWait;
        resolveWait = null;
        r();
      }
    });

    child.on("error", (err) => {
      pushMessage({
        type: "error",
        error: `Antigravity process error: ${err.message}`,
      });
      streamDone = true;
      if (resolveWait) {
        const r = resolveWait;
        resolveWait = null;
        r();
      }
    });

    try {
      while (!streamDone || messageQueue.length > 0) {
        if (messageQueue.length > 0) {
          yield messageQueue.shift()!;
        } else if (!streamDone) {
          await new Promise<void>((resolve) => {
            resolveWait = resolve;
          });
        }
      }

      if (fullResponse) {
        this.messages.push({ role: "assistant", content: fullResponse });
      }
    } finally {
      q.signal.removeEventListener("abort", onAbort);
      this.activeProc = null;
      this.endQuery(q.gen);
    }
  }
}

registerProviderFactory(
  PROVIDER_NAME,
  async (config) => new AntigravityLSProvider(config as AntigravityLSConfig)
);
