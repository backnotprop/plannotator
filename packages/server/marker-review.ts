import {
  profileHasCustomSection,
  type ResolvedReviewProfile,
} from "@plannotator/shared/review-profiles";
import {
  CURSOR_CLI_SIGNATURE,
  isSameProgram,
  resolveProgram,
  type ProgramSignature,
  type ResolvedProgram,
  type SameProgramCheck,
} from "@plannotator/shared/agent-program";
import {
  transformSeverityFindings,
  type ReviewSeverity,
  type ReviewFinding,
  type ReviewAnnotationInput,
} from "./review-findings";

/**
 * Shared machinery for review CLIs with no schema-validation flag: the model emits a marker-delimited JSON block and the last complete one is extracted.
 * Vendored into the Pi (Node) build, so it must contain no Bun.* APIs.
 */

// Tags carry a per-job nonce so bare mentions of the tag name in the diff or model prose are never mistaken for the real delimiter.

const MARKER_TAG = "plannotator-review-json";

export function markerOpen(nonce: string): string {
  return `<${MARKER_TAG}:${nonce}>`;
}
export function markerClose(nonce: string): string {
  return `</${MARKER_TAG}:${nonce}>`;
}

export function makeMarkerNonce(): string {
  return "pn" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

/** Null when absent: the parser then fails closed. */
export function extractMarkerNonce(prompt: string): string | null {
  const m = new RegExp(`<${MARKER_TAG}:(pn[0-9a-f]{12})>`).exec(prompt);
  return m ? m[1] : null;
}

export type MarkerSeverity = ReviewSeverity;
export type MarkerFinding = ReviewFinding;

export interface MarkerReviewSummary {
  correctness: string;
  explanation: string;
  confidence: number;
}

export interface MarkerReviewOutput {
  findings: MarkerFinding[];
  summary: MarkerReviewSummary;
}

const VALID_SEVERITIES: ReadonlySet<string> = new Set([
  "important",
  "nit",
  "pre_existing",
]);

// Hand-rolled validator: marker output is prompt-enforced, so this is the floor that makes it a trusted object.

/** Rejects fractional/NaN/Infinity: prompt-enforced output is not trusted as a coordinate. */
function optionalNullableInteger(value: unknown): { ok: true; value: number | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value === "number" && Number.isInteger(value)) return { ok: true, value };
  return { ok: false };
}

function optionalNullableString(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value === "string") return { ok: true, value };
  return { ok: false };
}

export function validateMarkerReviewOutput(parsed: unknown): MarkerReviewOutput | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.findings)) return null;

  const summary = obj.summary;
  if (!summary || typeof summary !== "object") return null;
  const s = summary as Record<string, unknown>;
  if (typeof s.correctness !== "string") return null;
  if (typeof s.explanation !== "string") return null;
  if (typeof s.confidence !== "number" || !Number.isFinite(s.confidence)) return null;

  const findings: MarkerFinding[] = [];
  for (const raw of obj.findings) {
    if (!raw || typeof raw !== "object") return null;
    const f = raw as Record<string, unknown>;

    if (typeof f.severity !== "string" || !VALID_SEVERITIES.has(f.severity)) return null;
    if (typeof f.description !== "string") return null;

    const file = optionalNullableString(f.file);
    if (!file.ok) return null;
    const line = optionalNullableInteger(f.line);
    if (!line.ok) return null;
    const endLine = optionalNullableInteger(f.end_line);
    if (!endLine.ok) return null;

    findings.push({
      severity: f.severity as MarkerSeverity,
      file: file.value,
      line: line.value,
      end_line: endLine.value,
      description: f.description,
      reasoning: typeof f.reasoning === "string" ? f.reasoning : "",
    });
  }

  return {
    findings,
    summary: {
      correctness: s.correctness,
      explanation: s.explanation,
      confidence: Math.max(0, Math.min(1, s.confidence)),
    },
  };
}

export interface MarkerModel {
  id: string;
  label: string;
}

export type MarkerStreamEvent = Record<string, unknown>;

export interface MarkerBuildOptions {
  /** Pi: `--thinking` level; xhigh is accepted only by codex-max models and Pi errors otherwise. */
  thinking?: string;
  /** Cursor: when false, `--sandbox` is omitted entirely (never `--sandbox disabled`) so the user's own Cursor sandbox config applies. */
  cursorSandbox?: boolean;
}

export type MarkerEngineId = "cursor" | "opencode" | "pi" | "copilot";

export interface MarkerEngine {
  id: MarkerEngineId;
  name: string;
  binary: string;
  /** Other install names of the same CLI, tried after `binary`; used only when it matches `binarySignature`, since other tools install a generic `agent`. */
  altBinaries?: readonly string[];
  binarySignature?: ProgramSignature;
  author: string;
  buildArgv: (prompt: string, model?: string, cwd?: string, opts?: MarkerBuildOptions) => string[];
  extractText: (event: MarkerStreamEvent) => string | null;
  /** undefined = unrelated event, null = successful terminal assistant outcome, string = safe failure. */
  extractError?: (event: MarkerStreamEvent) => string | null | undefined;
  modelsArgv: string[];
  parseModels: (stdout: string) => MarkerModel[];
  formatLogEvent: (event: MarkerStreamEvent) => string | null;
  /** Same run with the prompt on stdin, for where it cannot be an argument (a Windows `.cmd` shim runs through cmd.exe). Null when the argv is not this engine's. */
  promptOnStdin?: (argv: string[]) => { command: string[]; stdin: string } | null;
}

/** A real new text delta has `timestamp_ms` and no `model_call_id`; other assistant events re-emit text already seen. */
function cursorIsRealAssistantDelta(event: MarkerStreamEvent): boolean {
  return event.timestamp_ms !== undefined && event.model_call_id === undefined;
}

function cursorAssistantText(event: MarkerStreamEvent): string {
  if (typeof event.text === "string") return event.text;
  const message = event.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type?: string; text?: string } => !!p && typeof p === "object")
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join("");
  }
  return "";
}

/** Deliberately more lenient than cursorFormatLogEvent: keeps the no-timestamp end-of-turn flush as a parse safety net (the last marker block wins, so duplicates are harmless). Do not unify them. */
function cursorExtractText(event: MarkerStreamEvent): string | null {
  if (event.type === "assistant") {
    if (event.timestamp_ms !== undefined) {
      if (cursorIsRealAssistantDelta(event)) return cursorAssistantText(event);
      return null;
    }
    if (event.model_call_id === undefined) return cursorAssistantText(event);
    return null;
  }
  if (event.type === "result") {
    if (typeof event.result === "string") return event.result;
    if (typeof event.text === "string") return event.text;
    return null;
  }
  return null;
}

/** Parses `<id> - <Label>` lines; returns [] when there are none (e.g. unauthenticated). */
function cursorParseModels(stdout: string): MarkerModel[] {
  if (!stdout) return [];
  const models: MarkerModel[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    // Id is one whitespace-free token; the separator is " - " (ids contain hyphens but never " - ").
    const match = /^(\S+)\s+-\s+(.+)$/.exec(line);
    if (!match) continue;
    const id = match[1];
    const label = match[2].trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label });
  }
  return models;
}

function cursorFormatLogEvent(event: MarkerStreamEvent): string | null {
  switch (event.type) {
    case "system": {
      if (event.subtype === "init") {
        const model = typeof event.model === "string" ? event.model : undefined;
        const sessionId = typeof event.session_id === "string" ? event.session_id : undefined;
        const bits = ["[init]"];
        if (model) bits.push(`model=${model}`);
        if (sessionId) bits.push(`session=${sessionId}`);
        return bits.join(" ");
      }
      return null;
    }
    case "assistant": {
      if (!cursorIsRealAssistantDelta(event)) return null;
      const text = cursorAssistantText(event);
      return text ? text : null;
    }
    case "tool_call": {
      const name = typeof event.name === "string" ? event.name : "tool";
      if (event.subtype === "completed") {
        return `[${name}] completed`;
      }
      const args =
        typeof event.args === "string"
          ? event.args.slice(0, 100)
          : event.args !== undefined
            ? JSON.stringify(event.args).slice(0, 100)
            : "";
      return `[${name}] ${args}`.trimEnd();
    }
    case "result": {
      const duration =
        typeof event.duration_ms === "number" ? `${event.duration_ms}ms` : undefined;
      const requestId = typeof event.request_id === "string" ? event.request_id : undefined;
      const bits = ["[result]"];
      if (duration) bits.push(duration);
      if (requestId) bits.push(`request=${requestId}`);
      return bits.length > 1 ? bits.join(" ") : null;
    }
    default:
      return null;
  }
}

/**
 * Read-only posture comes from `--mode ask` + `--sandbox enabled` and no `--force`/`--yolo`. `--trust` is required headless: otherwise Cursor blocks on a workspace-trust prompt.
 * `cursorSandbox: false` omits the sandbox pair for systems where it cannot start (NixOS, AppArmor); write protection then rests on `--mode ask`.
 */
function cursorBuildArgv(
  prompt: string,
  model?: string,
  cwd?: string,
  opts?: MarkerBuildOptions,
): string[] {
  const useModel = !!model && model.toLowerCase() !== "auto";
  return [
    "cursor-agent",
    "-p",
    "--mode",
    "ask",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--trust",
    ...(cwd ? ["--workspace", cwd] : []),
    ...(opts?.cursorSandbox === false ? [] : ["--sandbox", "enabled"]),
    ...(useModel ? ["--model", model] : []),
    prompt,
  ];
}

/** No partial-output dedup is needed: each text part is finalized once. */
function opencodeExtractText(event: MarkerStreamEvent): string | null {
  if (event.type === "text") {
    const part = event.part as { text?: unknown } | undefined;
    if (typeof part?.text === "string") return part.text;
  }
  return null;
}

function opencodeParseModels(stdout: string): MarkerModel[] {
  if (!stdout) return [];
  const models: MarkerModel[] = [];
  const seen = new Set<string>();
  for (const rawLine of stdout.split("\n")) {
    const id = rawLine.trim();
    // A model id may carry extra `/` segments (e.g. openrouter/deepseek/deepseek-chat-v3).
    if (!id || /\s/.test(id) || !/^[^/\s]+\/\S+$/.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, label: id });
  }
  return models;
}

function opencodeFormatLogEvent(event: MarkerStreamEvent): string | null {
  const part = event.part as
    | { text?: unknown; tool?: unknown; state?: { status?: unknown } }
    | undefined;
  switch (event.type) {
    case "text": {
      const text = typeof part?.text === "string" ? part.text.trim() : "";
      return text ? text : null;
    }
    case "tool_use": {
      const tool = typeof part?.tool === "string" ? part.tool : "tool";
      const status = typeof part?.state?.status === "string" ? part.state.status : "";
      return `[${tool}] ${status}`.trimEnd();
    }
    case "error": {
      return "[error] session error";
    }
    default:
      return null;
  }
}

/** `--dir` is deliberately not passed: OpenCode 1.x means something else by it and v2 rejects it. The working directory is the spawn cwd; `cwd` only matches the shared buildArgv signature. */
function opencodeBuildArgv(prompt: string, model?: string, _cwd?: string): string[] {
  const useModel = !!model && model.trim().length > 0;
  return [
    "opencode",
    "run",
    "--format",
    "json",
    "--agent",
    "plan",
    ...(useModel ? ["--model", model] : []),
    prompt,
  ];
}

/** Reads `message_end` only: also summing `message_update` deltas would double the text. */
function piExtractText(event: MarkerStreamEvent): string | null {
  if (event.type !== "message_end") return null;
  const message = event.message as { role?: unknown; content?: unknown } | undefined;
  if (message?.role !== "assistant") return null;
  const content = message.content;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((b): b is { type?: string; text?: string } => !!b && typeof b === "object")
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
  return text ? text : null;
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

const MAX_PROVIDER_ERROR_CHARS = 500;

/** Bounded, redaction-safe line: the raw NDJSON record is never surfaced (it may be large and carry provider metadata). */
function sanitizeProviderError(message: unknown, fallback: string): string {
  if (typeof message !== "string") return fallback;

  let withoutControls = "";
  for (const char of stripAnsi(message)) {
    const code = char.charCodeAt(0);
    withoutControls += code < 32 || code === 127 ? " " : char;
  }

  const collapsed = withoutControls.replace(/\s+/g, " ").trim();
  if (!collapsed) return fallback;

  const redacted = collapsed
    .replace(
      /\b((?:api[-_ ]?key|access[-_ ]?token|authorization|client[-_ ]?secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|(?:Bearer\s+)?[^\s,;]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]");

  if (redacted.length <= MAX_PROVIDER_ERROR_CHARS) return redacted;
  return redacted.slice(0, MAX_PROVIDER_ERROR_CHARS - 1).trimEnd() + "…";
}

function piAssistantError(message: unknown): string | null | undefined {
  if (!message || typeof message !== "object") return undefined;
  if (Reflect.get(message, "role") !== "assistant") return undefined;

  const stopReason = Reflect.get(message, "stopReason");
  if (stopReason !== "error" && stopReason !== "aborted") {
    return stopReason === "stop" || stopReason === "length" || stopReason === "toolUse"
      ? null
      : undefined;
  }

  const fallback = stopReason === "aborted" ? "Pi request aborted" : "Pi request failed";
  return sanitizeProviderError(Reflect.get(message, "errorMessage"), fallback);
}

/** Pi exits 0 on in-run failures. The same AssistantMessage repeats across several events; accepting each location survives a truncated final event. */
function piExtractError(event: MarkerStreamEvent): string | null | undefined {
  switch (event.type) {
    case "message_update": {
      const assistantEvent = event.assistantMessageEvent;
      if (!assistantEvent || typeof assistantEvent !== "object") return undefined;
      if (Reflect.get(assistantEvent, "type") !== "error") return undefined;
      const nested = piAssistantError(Reflect.get(assistantEvent, "error"));
      if (typeof nested === "string") return nested;
      const reason = Reflect.get(assistantEvent, "reason");
      return reason === "aborted" ? "Pi request aborted" : "Pi request failed";
    }
    case "message_end":
    case "turn_end":
      return piAssistantError(event.message);
    case "agent_end": {
      const messages = event.messages;
      if (!Array.isArray(messages)) return undefined;
      for (let i = messages.length - 1; i >= 0; i--) {
        const error = piAssistantError(messages[i]);
        if (error !== undefined) return error;
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Pi prints a human table: locate the header row (provider, model) and accept only rows with the same column count, so non-table messages fail closed to []. */
function piParseModels(stdout: string): MarkerModel[] {
  try {
    if (!stdout) return [];
    const lines = stripAnsi(stdout)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const headerIndex = lines.findIndex((l) => {
      const cols = l.split(/\s+/);
      return cols[0]?.toLowerCase() === "provider" && cols[1]?.toLowerCase() === "model";
    });
    if (headerIndex === -1) return [];

    const columnCount = lines[headerIndex].split(/\s+/).length;
    const models: MarkerModel[] = [];
    const seen = new Set<string>();
    for (const line of lines.slice(headerIndex + 1)) {
      const cols = line.split(/\s+/);
      if (cols.length !== columnCount) continue;
      const [provider, model] = cols;
      if (!provider || !model) continue;
      const id = `${provider}/${model}`;
      if (seen.has(id)) continue;
      seen.add(id);
      models.push({ id, label: id });
    }
    return models;
  } catch {
    return [];
  }
}

/** Thinking content is deliberately not surfaced; assistant text appears once, on `message_end`. */
function piFormatLogEvent(event: MarkerStreamEvent): string | null {
  switch (event.type) {
    case "tool_execution_start": {
      const name = typeof event.toolName === "string" ? event.toolName : "tool";
      const args =
        event.args !== undefined ? JSON.stringify(event.args).slice(0, 100) : "";
      return `[${name}] ${args}`.trimEnd();
    }
    case "message_end": {
      const text = piExtractText(event);
      return text ? text : null;
    }
    default:
      return null;
  }
}

/**
 * `--no-approve` is a security requirement: non-interactive Pi would apply `defaultProjectTrust`, and an untrusted checkout's `.pi/settings.json`, extensions and skills must never load. Pi has no cwd flag; the spawn cwd is authoritative.
 * `pi --mode json` exits 0 even when the agent run errored (do not "fix"): marker parsing fails closed and the reducer keeps Pi's structured error. Exit 1 means Pi itself failed.
 */
function piBuildArgv(prompt: string, model?: string, cwd?: string, opts?: MarkerBuildOptions): string[] {
  void cwd;
  const useModel = !!model && model.trim().length > 0;
  return [
    "pi",
    "--mode",
    "json",
    "--no-session",
    "--no-approve",
    // Not `--tools read,grep,find,ls`: the prompts have the agent run git/gh through Bash. `--exclude-tools edit,write` removes only the mutation tools; Bash stays, as with Cursor/OpenCode. PR jobs run in disposable worktrees.
    "--exclude-tools",
    "edit,write",
    ...(useModel ? ["--model", model] : []),
    ...(opts?.thinking ? ["--thinking", opts.thinking] : []),
    "-p",
    prompt,
  ];
}

/** Pi reads piped stdin as the message, so the prompt can go on stdin instead of after `-p`. */
function piPromptOnStdin(argv: string[]): { command: string[]; stdin: string } | null {
  if (argv.length < 2 || argv[argv.length - 2] !== "-p") return null;
  return { command: argv.slice(0, -1), stdin: argv[argv.length - 1]! };
}

/** Reads `assistant.message` only: also summing `assistant.message_delta` would double the text. */
function copilotExtractText(event: MarkerStreamEvent): string | null {
  if (event.type !== "assistant.message") return null;
  const data = event.data as { content?: unknown } | undefined;
  return typeof data?.content === "string" && data.content ? data.content : null;
}

/** No model-list command: parses the `- "<id>"` lines under the `model` setting in `copilot help config`; no header fails closed to []. */
function copilotParseModels(stdout: string): MarkerModel[] {
  try {
    if (!stdout) return [];
    const lines = stripAnsi(stdout).split("\n");
    const headerIndex = lines.findIndex((l) => /^\s*`model`\s*:/.test(l));
    if (headerIndex === -1) return [];

    const models: MarkerModel[] = [];
    const seen = new Set<string>();
    for (const line of lines.slice(headerIndex + 1)) {
      const match = /^\s*-\s*"([^"]+)"\s*$/.exec(line);
      if (!match) break;
      const id = match[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, label: id });
    }
    return models;
  } catch {
    return [];
  }
}

function copilotFormatLogEvent(event: MarkerStreamEvent): string | null {
  const data = event.data as Record<string, unknown> | undefined;
  switch (event.type) {
    case "session.tools_updated": {
      const model = typeof data?.model === "string" ? data.model : undefined;
      return model ? `[init] model=${model}` : null;
    }
    case "tool.execution_start": {
      const name = typeof data?.toolName === "string" ? data.toolName : "tool";
      const args = data?.arguments !== undefined ? JSON.stringify(data.arguments).slice(0, 100) : "";
      return `[${name}] ${args}`.trimEnd();
    }
    case "tool.execution_complete": {
      const error = data?.error as { message?: unknown } | undefined;
      if (error && typeof error.message === "string") return `[tool] ${error.message}`;
      return null;
    }
    case "assistant.message": {
      const text = copilotExtractText(event);
      return text ? text : null;
    }
    default:
      return null;
  }
}

/**
 * `--no-ask-user` and non-interactive auto-deny keep the background job from prompting. `--deny-tool=write` removes file mutation; the allowlist opens only git/gh/glab/jj/wc inspection.
 * The `=` form keeps variadic permission flags from swallowing the next argument; `--disable-builtin-mcps` and `--no-auto-update` skip startup handshakes and update pauses.
 */
function copilotBuildArgv(prompt: string, model?: string, cwd?: string): string[] {
  const useModel = !!model && model.trim().length > 0 && model.toLowerCase() !== "auto";
  return [
    "copilot",
    ...(cwd ? ["-C", cwd] : []),
    "--output-format",
    "json",
    "--no-ask-user",
    "--no-auto-update",
    "--disable-builtin-mcps",
    "--deny-tool=write",
    // Deny rules beat every allow rule, at first-level-subcommand granularity: the broad git:*/gh:* allows stay for inspection while push, working-tree destruction (local reviews run in the user's real tree) and forge writes are blocked.
    "--deny-tool=shell(git push)",
    "--deny-tool=shell(git reset)",
    "--deny-tool=shell(git clean)",
    "--deny-tool=shell(git checkout)",
    "--deny-tool=shell(git restore)",
    "--deny-tool=shell(gh pr comment)",
    "--deny-tool=shell(gh pr create)",
    "--deny-tool=shell(gh pr merge)",
    "--deny-tool=shell(gh pr close)",
    "--deny-tool=shell(gh pr edit)",
    "--deny-tool=shell(gh pr review)",
    "--deny-tool=shell(gh issue comment)",
    "--deny-tool=shell(gh issue create)",
    "--deny-tool=shell(glab mr note)",
    "--deny-tool=shell(glab mr create)",
    "--deny-tool=shell(glab mr merge)",
    "--deny-tool=shell(glab mr close)",
    "--allow-tool=shell(git:*)",
    "--allow-tool=shell(gh:*)",
    "--allow-tool=shell(glab:*)",
    "--allow-tool=shell(jj:*)",
    "--allow-tool=shell(wc)",
    ...(useModel ? ["--model", model] : []),
    "-p",
    prompt,
  ];
}

const CURSOR_ENGINE: MarkerEngine = {
  id: "cursor",
  name: "Cursor CLI",
  binary: "cursor-agent",
  altBinaries: ["agent"],
  binarySignature: CURSOR_CLI_SIGNATURE,
  author: "Cursor",
  buildArgv: cursorBuildArgv,
  extractText: cursorExtractText,
  modelsArgv: ["models"],
  parseModels: cursorParseModels,
  formatLogEvent: cursorFormatLogEvent,
};

const OPENCODE_ENGINE: MarkerEngine = {
  id: "opencode",
  name: "OpenCode",
  binary: "opencode",
  author: "OpenCode",
  buildArgv: opencodeBuildArgv,
  extractText: opencodeExtractText,
  modelsArgv: ["models"],
  parseModels: opencodeParseModels,
  formatLogEvent: opencodeFormatLogEvent,
};

const PI_ENGINE: MarkerEngine = {
  id: "pi",
  name: "Pi",
  binary: "pi",
  author: "Pi",
  buildArgv: piBuildArgv,
  extractText: piExtractText,
  extractError: piExtractError,
  modelsArgv: ["--list-models"],
  parseModels: piParseModels,
  formatLogEvent: piFormatLogEvent,
  promptOnStdin: piPromptOnStdin,
};

const COPILOT_ENGINE: MarkerEngine = {
  id: "copilot",
  name: "Copilot CLI",
  binary: "copilot",
  author: "Copilot",
  buildArgv: copilotBuildArgv,
  extractText: copilotExtractText,
  modelsArgv: ["help", "config"],
  parseModels: copilotParseModels,
  formatLogEvent: copilotFormatLogEvent,
};

export const MARKER_ENGINES: Record<MarkerEngineId, MarkerEngine> = {
  cursor: CURSOR_ENGINE,
  opencode: OPENCODE_ENGINE,
  pi: PI_ENGINE,
  copilot: COPILOT_ENGINE,
};

export interface MarkerStreamReduction {
  canonicalText: string;
  recordCount: number;
  providerError: string | null;
}

/** The whole buffer is joined before splitting on newlines, so chunk boundaries never corrupt a record; a trailing line without a newline counts as complete. */
export function reduceMarkerStream(stdout: string, engine: MarkerEngine): MarkerStreamReduction {
  let canonicalText = "";
  let recordCount = 0;
  let providerError: string | null = null;

  if (!stdout) return { canonicalText, recordCount, providerError };

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    let event: MarkerStreamEvent;
    try {
      event = JSON.parse(line) as MarkerStreamEvent;
    } catch {
      continue;
    }
    recordCount++;

    const text = engine.extractText(event);
    if (text) canonicalText += text;

    const error = engine.extractError?.(event);
    if (error !== undefined) providerError = error;
  }

  return { canonicalText, recordCount, providerError };
}

/** Last complete block wins; the tags carry the job nonce, so bare mentions in the diff or prose are ignored. */
export function extractLastMarkerBlock(text: string, openTag: string, closeTag: string): string | null {
  let result: string | null = null;
  let searchFrom = 0;

  while (true) {
    const open = text.indexOf(openTag, searchFrom);
    if (open === -1) break;
    const contentStart = open + openTag.length;
    const close = text.indexOf(closeTag, contentStart);
    // A dangling opener means the final block was truncated: return null rather than fall back to an earlier draft or echoed example.
    if (close === -1) return null;
    result = text.slice(contentStart, close);
    searchFrom = close + closeTag.length;
  }

  return result;
}

export function parseMarkerStreamOutput(stdout: string, engine: MarkerEngine, nonce: string): MarkerReviewOutput | null {
  if (!stdout || !stdout.trim()) return null;
  if (!nonce) return null;

  const { canonicalText } = reduceMarkerStream(stdout, engine);
  if (!canonicalText) return null;

  const block = extractLastMarkerBlock(canonicalText, markerOpen(nonce), markerClose(nonce));
  if (block === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(block.trim());
  } catch {
    return null;
  }

  return validateMarkerReviewOutput(parsed);
}

export function formatMarkerLogEvent(line: string, engine: MarkerEngine): string | null {
  let event: MarkerStreamEvent;
  try {
    event = JSON.parse(line) as MarkerStreamEvent;
  } catch {
    return null;
  }
  return engine.formatLogEvent(event);
}

export const MARKER_REVIEW_METHODOLOGY = `# Code Review

## Your role
You are a senior engineer reviewing a code change. Find the bugs a maintainer
would fix before merging — logic errors, regressions, broken edge cases,
security holes with a real exploit path, data-loss risks. You are not a linter
or style checker. Optimize for findings that get resolved, not for volume: a
few real, well-evidenced bugs beat a long list of nits.

## Method — investigate before you report
You have tools. Use them. Do not judge the diff in isolation:
  - Read the full function and module around each change, not just the hunk.
  - Trace call sites and data flow to see how the changed code is actually used.
  - Read any repo guidance and honor it if present: AGENTS.md, CLAUDE.md,
    REVIEW.md, and any rules files at the repo root and in the directories
    you're reviewing. Treat these as authoritative for this repo and respect any
    skip/ignore rules they define.
  - Before reporting, check whether the issue is already handled elsewhere (a
    guard, try/catch, fallback, type guarantee).
  - Look at sibling code and tests: is the pattern you're flagging used safely
    elsewhere? Is the failure path you fear already covered?

## What to look for
  - Correctness: logic errors, regressions, broken edge cases, off-by-one,
    wrong results, build/type breakage.
  - Robustness: unhandled errors on realistic paths, resource/process leaks,
    races with observable consequences, state left inconsistent on failure.
  - Security (only when the change introduces it): execution of
    user/client-controlled input, trusting unvalidated external or model
    output, weakened trust/read-only guarantees, newly exposed surfaces.
  - Contracts & attribution: wrong file/line/path mapping, scope confusion, or a
    change to one side of a contract (types, API shape, parallel
    implementations) without the matching change on the other side.
  - Clear, citable violations of the repo guidance files above.

## Validate every finding
Confirm each candidate is real by tracing the actual code path. If you can't
show how it triggers, drop it — prefer silence over a false positive. The
confirmation you write becomes the \`reasoning\` field: what triggers it, what
breaks, and why it isn't already handled.

## Severity — report what a maintainer would actually fix
  important — should be fixed before merge: data loss, silent wrong results,
    security with an exploit path, crashes/leaks, contract drift that breaks a
    real consumer, fail-open where it must fail-closed.

  nit — minor and non-blocking: a real but low-impact edge case, missing
    handling on an unlikely path, a robustness gap with an easy workaround.

  pre_existing — a genuine bug in surrounding code NOT introduced by this
    change. Only flag when it directly affects the changed code path.

## Do NOT report
  - Formatting, naming, or style preferences (unless a repo guideline requires).
  - "Consider adding tests" — unless the change adds non-trivial logic with no
    test coverage at all.
  - Hypothetical problems needing exotic conditions with no real code path.
  - Speculative refactors or "this could be cleaner" outside the change's scope.

## Hard constraints
- This is a read-only review. Do NOT modify files.
- Do NOT post any comments to GitHub or GitLab. Do NOT use gh pr comment, glab,
  or any commenting tool.
- Never approve or block the change. Your only output is findings.`;

export function buildMarkerOutputContract(nonce: string): string {
  return `## Output contract
Your only machine-readable output is a single marker-delimited JSON block.
Any natural-language commentary you write must come BEFORE the final marker
block. Emit the block exactly once, as the last thing in your response. The
opening and closing tags carry a session id (after the colon) — reproduce both
tags EXACTLY as shown, including that id, or your findings will be discarded:

${markerOpen(nonce)}
{
  "findings": [
    {
      "file": "packages/server/review.ts",
      "line": 123,
      "end_line": 123,
      "severity": "important",
      "description": "The issue...",
      "reasoning": "Why this is a real issue..."
    }
  ],
  "summary": {
    "correctness": "Issues Found",
    "explanation": "One important issue was found.",
    "confidence": 0.85
  }
}
${markerClose(nonce)}

Schema:
- findings: array of objects, each with
  - file: string or null — path as shown in the diff. Use null for a general,
    review-level note that isn't about any one file.
  - line: integer or null — start line, post-change numbering. Give a line for a
    line-level issue; use null for a whole-file issue or a general note.
  - end_line: integer or null — end line; equal to line for a single line, null
    when line is null.
  - severity: one of "important", "nit", "pre_existing"
  - description: string (one paragraph) — state the IMPACT (what breaks, for
    whom) and the TRIGGER (when it happens); suggest a minimal fix if obvious
  - reasoning: string (how the issue was confirmed)
- summary: object with
  - correctness: string ("Correct" or "Issues Found")
  - explanation: string (one sentence)
  - confidence: number between 0 and 1

Place each finding by how specific it is: give file AND line for a line-level
issue; give file with line null for a whole-file issue; set both file and line
null for a general, review-level note. Never invent a line you are unsure of —
drop to a file or general placement instead of guessing. Cite file/line from the
new (post-change) code. One finding per distinct bug — do not stack unrelated
issues. If no issues are found, return an empty "findings" array with a valid
summary.`;
}

/** A custom profile replaces the methodology, but the marker output contract is always appended: it is the only thing that makes the output parseable (composeReviewPrompt would strip it). */
export function composeMarkerReviewPrompt(
  profile: ResolvedReviewProfile | undefined,
  userMessage: string,
  nonce: string,
): string {
  const head = profileHasCustomSection(profile)
    ? (profile as ResolvedReviewProfile).instructions.trim()
    : MARKER_REVIEW_METHODOLOGY;
  return head + "\n\n" + buildMarkerOutputContract(nonce) + "\n\n---\n\n" + userMessage;
}

export interface MarkerCommandResult {
  command: string[];
}

/** `binary`, else an `altBinaries` name that is the same CLI (never another tool's `agent`); null if none is installed. */
export function resolveMarkerBinary(
  engine: MarkerEngine,
  which: (name: string) => string | null,
  sameProgram: SameProgramCheck = isSameProgram,
): Promise<ResolvedProgram | null> {
  return resolveProgram({ command: engine.binary, alt: engine.altBinaries, signature: engine.binarySignature }, which, sameProgram);
}

/** When none was found the argv keeps the engine's own name, so the spawn fails as "not found" rather than starting another program. */
export function withMarkerBinary(command: string[], engine: MarkerEngine, resolved: ResolvedProgram | null): string[] {
  if (!engine.altBinaries?.length) return command;
  const names = [engine.binary, ...engine.altBinaries];
  if (command.length === 0 || !names.includes(command[0]!)) return command;
  // By name: the spawn looks it up on the same PATH and finds the file that was checked.
  return [resolved?.name ?? engine.binary, ...command.slice(1)];
}

export function buildMarkerCommand(
  engine: MarkerEngine,
  prompt: string,
  model?: string,
  cwd?: string,
  opts?: MarkerBuildOptions,
): MarkerCommandResult {
  return { command: engine.buildArgv(prompt, model, cwd, opts) };
}

export type MarkerReviewAnnotationInput = ReviewAnnotationInput;

export function transformMarkerFindings(
  findings: MarkerFinding[],
  source: string,
  author: string,
  cwd?: string,
  pathTransform?: (path: string) => string,
): MarkerReviewAnnotationInput[] {
  return transformSeverityFindings(findings, source, author, cwd, pathTransform);
}
