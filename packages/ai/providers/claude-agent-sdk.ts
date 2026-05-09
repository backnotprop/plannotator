/**
 * Claude Agent SDK provider — the first concrete AIProvider implementation.
 *
 * Uses @anthropic-ai/claude-agent-sdk to create sessions that can:
 * - Start fresh with Plannotator context as the system prompt
 * - Fork from a parent Claude Code session (preserving full history)
 * - Resume a previous Plannotator inline chat session
 * - Stream text deltas back to the UI in real time
 *
 * Sessions are read-only by default (tools limited to Read, Glob, Grep)
 * to keep inline chat safe and cost-bounded.
 */

import { buildSystemPrompt, buildForkPreamble, buildEffectivePrompt } from "../context.ts";
import { BaseSession } from "../base-session.ts";
import type {
  AIProvider,
  AIProviderCapabilities,
  AISession,
  AIMessage,
  CreateSessionOptions,
  ClaudeAgentSDKConfig,
} from "../types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_NAME = "claude-agent-sdk";

/** Default read-only tools for inline chat. */
const DEFAULT_ALLOWED_TOOLS = ["Read", "Glob", "Grep", "WebSearch"];

const DEFAULT_MAX_TURNS = 99;
const DEFAULT_MODEL = "claude-sonnet-4-6";

// ---------------------------------------------------------------------------
// SDK query options — typed to catch typos at compile time
// ---------------------------------------------------------------------------

interface ClaudeSDKQueryOptions {
  model: string;
  maxTurns: number;
  allowedTools: string[];
  cwd: string;
  abortController: AbortController;
  includePartialMessages: boolean;
  persistSession: boolean;
  maxBudgetUsd?: number;
  systemPrompt?: string | { type: "preset"; preset: string; append?: string };
  resume?: string;
  forkSession?: boolean;
  permissionMode?: ClaudeAgentSDKConfig['permissionMode'];
  allowDangerouslySkipPermissions?: boolean;
  pathToClaudeCodeExecutable?: string;
  settingSources?: string[];
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class ClaudeAgentSDKProvider implements AIProvider {
  readonly name = PROVIDER_NAME;
  readonly capabilities: AIProviderCapabilities = {
    fork: true,
    resume: true,
    streaming: true,
    tools: true,
  };
  readonly models = [
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', default: true },
    { id: 'claude-sonnet-4-6[1m]', label: 'Sonnet 4.6 (1M)' },
    { id: 'claude-opus-4-7', label: 'Opus 4.7' },
    { id: 'claude-opus-4-7[1m]', label: 'Opus 4.7 (1M)' },
    { id: 'claude-opus-4-6', label: 'Opus 4.6' },
    { id: 'claude-opus-4-6[1m]', label: 'Opus 4.6 (1M)' },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  ] as const;

  private config: ClaudeAgentSDKConfig;

  constructor(config: ClaudeAgentSDKConfig) {
    this.config = config;
  }

  async createSession(options: CreateSessionOptions): Promise<AISession> {
    return new ClaudeAgentSDKSession({
      ...this.baseConfig(options),
      systemPrompt: buildSystemPrompt(options.context),
      cwd: options.cwd ?? this.config.cwd ?? process.cwd(),
      parentSessionId: null,
      forkFromSession: null,
    });
  }

  async forkSession(options: CreateSessionOptions): Promise<AISession> {
    const parent = options.context.parent;
    if (!parent) {
      throw new Error(
        "Cannot fork: no parent session provided in context. " +
          "Use createSession() for standalone sessions."
      );
    }

    return new ClaudeAgentSDKSession({
      ...this.baseConfig(options),
      systemPrompt: null,
      forkPreamble: buildForkPreamble(options.context),
      cwd: parent.cwd,
      parentSessionId: parent.sessionId,
      forkFromSession: parent.sessionId,
    });
  }

  async resumeSession(sessionId: string): Promise<AISession> {
    return new ClaudeAgentSDKSession({
      ...this.baseConfig(),
      systemPrompt: null,
      cwd: this.config.cwd ?? process.cwd(),
      parentSessionId: null,
      forkFromSession: null,
      resumeSessionId: sessionId,
    });
  }

  dispose(): void {
    // No persistent resources to clean up
  }

  private baseConfig(options?: CreateSessionOptions) {
    return {
      model: options?.model ?? this.config.model ?? DEFAULT_MODEL,
      maxTurns: options?.maxTurns ?? DEFAULT_MAX_TURNS,
      maxBudgetUsd: options?.maxBudgetUsd,
      allowedTools: this.config.allowedTools ?? DEFAULT_ALLOWED_TOOLS,
      permissionMode: this.config.permissionMode ?? "default",
      claudeExecutablePath: this.config.claudeExecutablePath,
      settingSources: this.config.settingSources ?? ['user', 'project'],
    };
  }
}

// ---------------------------------------------------------------------------
// SDK import cache — resolve once, reuse across all queries
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: SDK types resolved at runtime via dynamic import
let sdkQueryFn: ((...args: any[]) => any) | null = null;

async function getSDKQuery() {
  if (!sdkQueryFn) {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    sdkQueryFn = sdk.query;
  }
  return sdkQueryFn!;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

interface SessionConfig {
  systemPrompt: string | null;
  forkPreamble?: string;
  model: string;
  maxTurns: number;
  maxBudgetUsd?: number;
  allowedTools: string[];
  permissionMode: ClaudeAgentSDKConfig['permissionMode'];
  cwd: string;
  parentSessionId: string | null;
  forkFromSession: string | null;
  resumeSessionId?: string;
  claudeExecutablePath?: string;
  settingSources?: string[];
}

class ClaudeAgentSDKSession extends BaseSession {
  private config: SessionConfig;
  /** Active Query object — needed to send control responses (permission decisions) */
  private _activeQuery: { streamInput: (iter: AsyncIterable<unknown>) => Promise<void> } | null = null;

  constructor(config: SessionConfig) {
    super({
      parentSessionId: config.parentSessionId,
      initialId: config.resumeSessionId,
    });
    this.config = config;
  }

  async *query(prompt: string): AsyncIterable<AIMessage> {
    const started = this.startQuery();
    if (!started) { yield BaseSession.BUSY_ERROR; return; }
    const { gen } = started;

    try {
      const queryFn = await getSDKQuery();

      const queryPrompt = buildEffectivePrompt(
        prompt,
        this.config.forkPreamble ?? null,
        this._firstQuerySent,
      );
      const options = this.buildQueryOptions();

      const stream = queryFn({ prompt: queryPrompt, options }) as
        AsyncIterable<Record<string, unknown>> & { streamInput: (iter: AsyncIterable<unknown>) => Promise<void> };
      this._activeQuery = stream;

      this._firstQuerySent = true;

      for await (const message of stream) {
        const mapped = mapSDKMessage(message);

        // Capture the real session ID from the init message
        if (
          !this._resolvedId &&
          "session_id" in message &&
          typeof message.session_id === "string" &&
          message.session_id
        ) {
          this.resolveId(message.session_id);
        }

        for (const msg of mapped) {
          yield msg;
        }
      }
    } catch (err) {
      yield {
        type: "error",
        error: err instanceof Error ? err.message : String(err),
        code: "provider_error",
      };
    } finally {
      this.endQuery(gen);
      this._activeQuery = null;
    }
  }

  abort(): void {
    this._activeQuery = null;
    super.abort();
  }

  respondToPermission(requestId: string, allow: boolean, message?: string): void {
    if (!this._activeQuery || !this._activeQuery.streamInput) return;

    const response = allow
      ? { type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'allow' } } }
      : { type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message: message ?? 'User denied this action' } } };

    this._activeQuery.streamInput(
      (async function* () { yield response; })()
    ).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private buildQueryOptions(): ClaudeSDKQueryOptions {
    const opts: ClaudeSDKQueryOptions = {
      model: this.config.model,
      maxTurns: this.config.maxTurns,
      allowedTools: this.config.allowedTools,
      cwd: this.config.cwd,
      abortController: this._currentAbort!,
      includePartialMessages: true,
      persistSession: true,
      ...(this.config.claudeExecutablePath && {
        pathToClaudeCodeExecutable: this.config.claudeExecutablePath,
      }),
      ...(this.config.settingSources && {
        settingSources: this.config.settingSources,
      }),
    };

    if (this.config.maxBudgetUsd) {
      opts.maxBudgetUsd = this.config.maxBudgetUsd;
    }

    // After the first query resolves a real session ID, all subsequent
    // queries must resume that session to continue the conversation.
    if (this._resolvedId) {
      opts.resume = this._resolvedId;
      return this.applyPermissionMode(opts);
    }

    // First query: use Claude Code's built-in prompt with our context appended
    if (this.config.systemPrompt) {
      opts.systemPrompt = {
        type: "preset",
        preset: "claude_code",
        append: this.config.systemPrompt,
      };
    }

    if (this.config.forkFromSession) {
      opts.resume = this.config.forkFromSession;
      opts.forkSession = true;
    }

    if (this.config.resumeSessionId) {
      opts.resume = this.config.resumeSessionId;
    }

    return this.applyPermissionMode(opts);
  }

  private applyPermissionMode(opts: ClaudeSDKQueryOptions): ClaudeSDKQueryOptions {
    if (this.config.permissionMode === "bypassPermissions") {
      opts.permissionMode = "bypassPermissions";
      opts.allowDangerouslySkipPermissions = true;
    } else if (this.config.permissionMode === "plan") {
      opts.permissionMode = "plan";
    }
    return opts;
  }
}

// ---------------------------------------------------------------------------
// Message mapping
// ---------------------------------------------------------------------------

/**
 * Map an SDK message to one or more AIMessages.
 *
 * An SDK assistant message can contain both text and tool_use content blocks
 * in a single response. We emit each block as a separate AIMessage so no
 * content is dropped.
 */
function mapSDKMessage(msg: Record<string, unknown>): AIMessage[] {
  const type = msg.type as string;

  switch (type) {
    case "assistant": {
      const message = msg.message as Record<string, unknown> | undefined;
      if (!message) return [{ type: "unknown", raw: msg }];
      const content = message.content as Array<Record<string, unknown>>;
      if (!content) return [{ type: "unknown", raw: msg }];

      const messages: AIMessage[] = [];
      const textParts: string[] = [];

      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          // Flush accumulated text before the tool_use block
          if (textParts.length > 0) {
            messages.push({ type: "text", text: textParts.join("") });
            textParts.length = 0;
          }
          messages.push({
            type: "tool_use",
            toolName: block.name as string,
            toolInput: block.input as Record<string, unknown>,
            toolUseId: block.id as string,
          });
        }
      }

      // Flush any remaining text after the last block
      if (textParts.length > 0) {
        messages.push({ type: "text", text: textParts.join("") });
      }

      return messages.length > 0 ? messages : [{ type: "unknown", raw: msg }];
    }

    case "stream_event": {
      const event = msg.event as Record<string, unknown> | undefined;
      if (!event) return [{ type: "unknown", raw: msg }];
      const eventType = event.type as string;

      if (eventType === "content_block_delta") {
        const delta = event.delta as Record<string, unknown>;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          return [{ type: "text_delta", delta: delta.text }];
        }
      }
      return [{ type: "unknown", raw: msg }];
    }

    case "user": {
      // SDK wraps tool results in SDKUserMessage (type: "user")
      if (msg.tool_use_result != null) {
        return [{
          type: "tool_result",
          result: typeof msg.tool_use_result === "string"
            ? msg.tool_use_result
            : JSON.stringify(msg.tool_use_result),
        }];
      }
      return [{ type: "unknown", raw: msg }];
    }

    case "control_request": {
      const request = msg.request as Record<string, unknown> | undefined;
      if (request?.subtype === "can_use_tool") {
        return [{
          type: "permission_request",
          requestId: msg.request_id as string,
          toolName: request.tool_name as string,
          toolInput: (request.input as Record<string, unknown>) ?? {},
          title: request.title as string | undefined,
          displayName: request.display_name as string | undefined,
          description: request.description as string | undefined,
          toolUseId: request.tool_use_id as string,
        }];
      }
      return [{ type: "unknown", raw: msg }];
    }

    case "result": {
      const sessionId = (msg.session_id as string) ?? "";
      const subtype = msg.subtype as string;
      return [{
        type: "result",
        sessionId,
        success: subtype === "success",
        result: (msg.result as string) ?? undefined,
        costUsd: msg.total_cost_usd as number | undefined,
        turns: msg.num_turns as number | undefined,
      }];
    }

    default:
      return [{ type: "unknown", raw: msg }];
  }
}

// ---------------------------------------------------------------------------
// Factory registration
// ---------------------------------------------------------------------------

import { registerProviderFactory } from "../provider.ts";

registerProviderFactory(
  PROVIDER_NAME,
  async (config) => new ClaudeAgentSDKProvider(config as ClaudeAgentSDKConfig)
);
