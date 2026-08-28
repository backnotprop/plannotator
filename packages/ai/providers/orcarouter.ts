/**
 * OrcaRouter provider — bridges Plannotator's AI layer with OrcaRouter's
 * OpenAI-compatible gateway.
 *
 * OrcaRouter exposes a provider/model namespace over a single endpoint (like
 * OpenRouter) and speaks the Anthropic Messages API on `/v1/messages`, so this
 * provider needs no local agent CLI: it authenticates with `ORCAROUTER_API_KEY`
 * and streams plain text (no tool execution — the gateway is a model endpoint,
 * not an agent runtime).
 *
 * The model catalog is static because the gateway names its own namespace
 * (`anthropic/claude-sonnet-5`, `orcarouter/fusion`, ...). No fetchModels()
 * discovery is needed, and the UI's model picker works from the first
 * capabilities probe.
 */

import { BaseSession } from "../base-session.ts";
import { buildSystemPrompt } from "../context.ts";
import { registerProviderFactory } from "../provider.ts";
import type {
  AIMessage,
  AIProvider,
  AIProviderCapabilities,
  AISession,
  CreateSessionOptions,
  OrcaRouterConfig,
} from "../types.ts";

const PROVIDER_NAME = "orcarouter";

/** Default gateway base URL. Override with `ORCAROUTER_BASE_URL`. */
const DEFAULT_BASE_URL = "https://api.orcarouter.ai/v1";

/**
 * The models OrcaRouter exposes through the Anthropic-compatible endpoint.
 * Kept in sync with `GET /v1/models`. Defaults to `orcarouter/fusion` (the
 * adaptive-routing model that selects the best upstream per request).
 */
const DEFAULT_MODELS: ReadonlyArray<{
  id: string;
  label: string;
  default?: boolean;
}> = [
  { id: "orcarouter/fusion", label: "OrcaRouter Fusion", default: true },
  { id: "orcarouter/fusion-flash", label: "OrcaRouter Fusion Flash" },
  { id: "orcarouter/fusion-mini", label: "OrcaRouter Fusion Mini" },
  { id: "orcarouter/auto", label: "OrcaRouter Auto" },
  { id: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5 (via OrcaRouter)" },
  { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5 (via OrcaRouter)" },
];

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Split an SSE byte stream into `event:`/`data:` blocks. Each returned chunk
 * is one complete `data:` line's value. Handles CRLF and the `\r` that some
 * gateways leave on the end of a line.
 */
export function splitSseChunks(input: string): string[] {
  const chunks: string[] = [];
  for (const block of input.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        chunks.push(line.slice(5).trimStart());
      }
    }
  }
  return chunks;
}

/**
 * Parse one Anthropic Messages SSE data line into an AIMessage.
 *
 * The gateway streams `message_start`, `content_block_delta`, `message_delta`
 * and `message_stop` events; `message_start` also carries the backend session
 * (message) id, which we adopt as the resolved session id.
 */
export function mapAnthropicSseData(data: string, currentId: string): AIMessage[] {
  if (data === "[DONE]") return [];
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(data);
  } catch {
    return [{ type: "unknown", raw: { raw: data } }];
  }

  switch (parsed.type) {
    case "message_start": {
      const message = parsed.message as Record<string, unknown> | undefined;
      const id = typeof message?.id === "string" ? message.id : undefined;
      return id ? [{ type: "unknown", raw: { sessionId: id } }] : [];
    }
    case "content_block_delta": {
      const delta = parsed.delta as Record<string, unknown> | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        return [{ type: "text_delta", delta: delta.text }];
      }
      return [];
    }
    case "message_delta": {
      // The stop_reason is carried on the final delta; nothing to surface as a
      // message in itself.
      return [];
    }
    case "message_stop":
      return [{ type: "result", sessionId: currentId, success: true }];
    case "error": {
      const error = parsed.error as Record<string, unknown> | undefined;
      return [
        {
          type: "error",
          error: (error?.message as string) ?? "OrcaRouter error",
          code: "orcarouter_error",
        },
      ];
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class OrcaRouterProvider implements AIProvider {
  readonly name = PROVIDER_NAME;
  readonly capabilities: AIProviderCapabilities = {
    fork: false, // the gateway is stateless per message; sessions are local only
    resume: false, // no server-side conversation state to resume by id
    streaming: true,
    tools: false, // model endpoint — no tool execution
  };
  readonly models = DEFAULT_MODELS;

  private config: OrcaRouterConfig;

  constructor(config: OrcaRouterConfig) {
    this.config = config;
  }

  async createSession(options: CreateSessionOptions): Promise<AISession> {
    return new OrcaRouterSession({
      systemPrompt: buildSystemPrompt(options.context),
      baseUrl: this.config.baseUrl ?? DEFAULT_BASE_URL,
      apiKey: this.config.apiKey ?? "",
      model: options.model ?? this.config.model ?? DEFAULT_MODELS[0].id,
      parentSessionId: null,
    });
  }

  async forkSession(): Promise<never> {
    throw new Error(
      "OrcaRouter does not support session forking. " +
        "The endpoint layer should fall back to createSession().",
    );
  }

  async resumeSession(_sessionId: string): Promise<never> {
    throw new Error(
      "OrcaRouter does not support resuming sessions by id — " +
        "the gateway keeps no server-side conversation state. " +
        "Create a new session instead.",
    );
  }

  dispose(): void {
    // No persistent resources to clean up.
  }
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

interface SessionConfig {
  systemPrompt: string | null;
  baseUrl: string;
  apiKey: string;
  model: string;
  parentSessionId: string | null;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

class OrcaRouterSession extends BaseSession {
  private config: SessionConfig;
  private history: AnthropicMessage[] = [];
  /** Abort controller for the in-flight fetch; aborted by abort(). */
  private _activeAbort: AbortController | null = null;

  constructor(config: SessionConfig) {
    super({ parentSessionId: config.parentSessionId });
    this.config = config;
  }

  async *query(prompt: string): AsyncIterable<AIMessage> {
    const started = this.startQuery();
    if (!started) {
      yield BaseSession.BUSY_ERROR;
      return;
    }
    const { gen, signal } = started;

    try {
      const messages: AnthropicMessage[] = [
        ...this.history,
        { role: "user", content: prompt },
      ];
      // Chain the base session's abort signal (from startQuery) so abort()
      // cancels the in-flight fetch.
      const abortController = new AbortController();
      this._activeAbort = abortController;
      if (signal.aborted) abortController.abort();
      signal.addEventListener("abort", () => abortController.abort(), { once: true });
      const response = await fetch(`${this.config.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: 2048,
          // The system prompt is seeded once on the first turn via the API's
          // own `system` field; later turns keep the full message history and
          // no preamble.
          ...(this.config.systemPrompt && !this._firstQuerySent
            ? { system: this.config.systemPrompt }
            : {}),
          messages,
          stream: true,
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        yield {
          type: "error",
          error: `OrcaRouter request failed (${response.status}): ${body}`,
          code: "orcarouter_http_error",
        };
        return;
      }

      if (!response.body) {
        yield {
          type: "error",
          error: "OrcaRouter returned an empty response body",
          code: "orcarouter_empty_response",
        };
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";
      let turnDone = false;

      try {
        while (!turnDone) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // The gateway flushes complete SSE events; split on the blank line
          // that terminates each event block.
          let eventEnd = buffer.indexOf("\n\n");
          while (eventEnd !== -1) {
            const block = buffer.slice(0, eventEnd);
            buffer = buffer.slice(eventEnd + 2);
            for (const data of splitSseChunks(block)) {
              const messages = mapAnthropicSseData(data, this.id);
              for (const message of messages) {
                if (
                  message.type === "unknown" &&
                  "sessionId" in message.raw &&
                  typeof message.raw.sessionId === "string"
                ) {
                  // Adopt the gateway's message id as the session id so the
                  // session manager keys this conversation by something stable.
                  this.resolveId(message.raw.sessionId);
                  continue;
                }
                if (message.type === "text_delta") {
                  assistantText += message.delta;
                }
                if (message.type === "result") {
                  turnDone = true;
                }
                yield message;
              }
            }
            eventEnd = buffer.indexOf("\n\n");
          }
        }
      } finally {
        reader.releaseLock();
      }

      this._firstQuerySent = true;
      // Keep the conversation local so subsequent queries continue the thread.
      this.history.push({ role: "user", content: prompt });
      if (assistantText) {
        this.history.push({ role: "assistant", content: assistantText });
      }
    } catch (err) {
      yield {
        type: "error",
        error: err instanceof Error ? err.message : String(err),
        code: "provider_error",
      };
    } finally {
      this._activeAbort = null;
      this.endQuery(gen);
    }
  }

  abort(): void {
    this._activeAbort?.abort();
    super.abort();
  }
}

// ---------------------------------------------------------------------------
// Factory registration
// ---------------------------------------------------------------------------

registerProviderFactory(
  PROVIDER_NAME,
  async (config) => new OrcaRouterProvider(config as OrcaRouterConfig),
);
