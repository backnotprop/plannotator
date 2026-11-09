/**
 * DSH plan review through Plannotator.
 *
 * DSH's `exit_plan_mode` asks for the review on the Agent-scoped
 * `user-questions/request` waterfall: one question whose `intent.kind` is
 * "plan-review", the plan markdown in `detail`, and the approving option's
 * label in `intent.approve`. This listener answers it by running
 * `plannotator dsh-plan` and maps the decision onto the answer DSH's plan mode
 * reads (DSH packages/plan/plan-mode):
 *   approve          → the approve label alone (DSH leaves plan mode)
 *   approve + notes  → the approve label, then the composed notes message
 *                      steered into the agent as a user message (the answer
 *                      itself has no room for notes)
 *   keep planning    → no label and the composed feedback as `custom` text
 * A request that is not a plan review, and every failure of ours (no CLI, a
 * non-zero exit, unreadable output), goes to `next()`, so DSH's own review
 * card still works. An aborted request (turn cancelled) stops the CLI and
 * rejects, as DSH expects of an answerer.
 */

import { randomUUID } from "node:crypto";
import { resolvePlannotatorBinary, runDshPlan, type DshPlanResult } from "./cli";

/** The subset of DSH's question shapes this plugin reads. */
export interface DshQuestion {
  id: string;
  detail?: string;
  intent?: { kind: string; approve?: string };
}

export interface DshAnswer {
  answers: { id: string; selected: string[]; custom?: string }[];
}

export interface DshAgent {
  session: { header?: { cwd?: string } };
  steer?(message: DshUserMessage): void;
}

export interface DshQuestionRequest {
  questions: DshQuestion[];
  agent?: DshAgent;
  signal?: AbortSignal;
}

/** A DSH user message, built as `createUserMessage` from dsh-llm builds it. */
export interface DshUserMessage {
  readonly id: string;
  readonly role: "user";
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly source: { readonly kind: "user" };
}

export interface DshLogger {
  info?(format: string, ...args: unknown[]): void;
  warn?(format: string, ...args: unknown[]): void;
}

/** The subset of the Cordis context this plugin uses. */
export interface DshContext {
  on(
    event: "user-questions/request",
    listener: (request: DshQuestionRequest, next: () => Promise<DshAnswer>) => Promise<DshAnswer>,
    options?: { prepend?: boolean },
  ): unknown;
  get?(name: string): unknown;
  /** Runs `execute` now; the disposer it returns runs when the plugin unloads. */
  effect?(execute: () => () => void): unknown;
  logger?: DshLogger;
}

export interface ResolvedConfig {
  binary?: string;
  planReview: boolean;
}

export interface PlanReviewDeps {
  resolveBinary?: (configured?: string) => string | undefined;
  run?: typeof runDshPlan;
  /** Aborted when the plugin unloads; an open review then goes back to DSH. */
  unloadSignal?: AbortSignal;
}

function anySignal(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return present.length > 1 ? AbortSignal.any(present) : present[0];
}

/** The single plan-review question of a request, or undefined for anything else. */
export function planReviewQuestion(request: DshQuestionRequest | undefined): (DshQuestion & { detail: string; intent: { kind: "plan-review"; approve: string } }) | undefined {
  const questions = request?.questions;
  if (!Array.isArray(questions) || questions.length !== 1) return undefined;
  const question = questions[0];
  if (question?.intent?.kind !== "plan-review" || typeof question.intent.approve !== "string") return undefined;
  if (typeof question.detail !== "string" || !question.detail.trim()) return undefined;
  return question as DshQuestion & { detail: string; intent: { kind: "plan-review"; approve: string } };
}

/** The session's current directory, else the directory it started in. */
export function sessionCwd(ctx: DshContext, agent: DshAgent | undefined): string | undefined {
  if (!agent) return undefined;
  try {
    const workingDirectory = ctx.get?.("workingDirectory") as { get?(session: unknown): unknown } | undefined;
    const current = workingDirectory?.get?.(agent.session);
    if (typeof current === "string" && current) return current;
  } catch {
    // The service may be absent or not ready; the header still names the project.
  }
  const original = agent.session?.header?.cwd;
  return typeof original === "string" && original ? original : undefined;
}

export function createUserMessage(text: string): DshUserMessage {
  return Object.freeze({
    id: randomUUID(),
    role: "user" as const,
    content: Object.freeze([Object.freeze({ type: "text" as const, text })]),
    source: Object.freeze({ kind: "user" as const }),
  });
}

/** The answer DSH's plan mode reads for one decision. */
export function answerFor(question: { id: string; intent: { approve: string } }, result: DshPlanResult): DshAnswer {
  if (result.approved) return { answers: [{ id: question.id, selected: [question.intent.approve] }] };
  const custom = result.message ?? result.feedback;
  return { answers: [{ id: question.id, selected: [], ...(custom && { custom }) }] };
}

const URL_RE = /https?:\/\/\S+/;

export function createPlanReviewListener(ctx: DshContext, config: ResolvedConfig, deps: PlanReviewDeps = {}) {
  const resolveBinary = deps.resolveBinary ?? ((configured?: string) => resolvePlannotatorBinary({ configured }));
  const run = deps.run ?? runDshPlan;
  const warn = (format: string, ...args: unknown[]) => {
    try {
      ctx.logger?.warn?.(format, ...args);
    } catch {
      // Logging is best-effort.
    }
  };

  return async function planReview(request: DshQuestionRequest, next: () => Promise<DshAnswer>): Promise<DshAnswer> {
    const question = planReviewQuestion(request);
    if (!question) return next();

    const binary = resolveBinary(config.binary);
    if (!binary) {
      warn("plannotator: the plannotator CLI was not found (set the plugin's `binary` or PLANNOTATOR_BIN); using DSH's own plan review");
      return next();
    }

    let result: DshPlanResult;
    try {
      result = await run({
        binary,
        plan: question.detail,
        cwd: sessionCwd(ctx, request.agent),
        signal: anySignal(request.signal, deps.unloadSignal),
        // Remote sessions open no browser: the URL the CLI prints is the way in.
        onStderr: (chunk) => {
          for (const line of chunk.split(/\r?\n/)) {
            if (URL_RE.test(line)) {
              try {
                ctx.logger?.info?.("plannotator: %s", line.trim());
              } catch {
                // Logging is best-effort.
              }
            }
          }
        },
      });
    } catch (error) {
      if (request.signal?.aborted) throw error;
      warn("plannotator: plan review failed (%s); using DSH's own plan review", error instanceof Error ? error.message : String(error));
      return next();
    }

    if (result.approved && result.message) {
      try {
        request.agent?.steer?.(createUserMessage(result.message));
      } catch (error) {
        warn("plannotator: could not deliver the approval notes: %s", error instanceof Error ? error.message : String(error));
      }
    }
    return answerFor(question, result);
  };
}

/**
 * The plugin config from the profile's cordis patch: `{ binary?, planReview? }`.
 * A wrong type or an unknown key fails plugin load instead of being ignored.
 */
export function resolveConfig(config: unknown): ResolvedConfig {
  if (config === undefined || config === null) return { planReview: true };
  if (typeof config !== "object" || Array.isArray(config)) {
    throw new Error("@plannotator/dsh config must be an object: { binary?, planReview? }");
  }
  const record = config as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => key !== "binary" && key !== "planReview");
  if (unknown.length > 0) {
    throw new Error(`@plannotator/dsh config has unknown key(s) ${unknown.join(", ")}; config is { binary?, planReview? }`);
  }
  if (record.binary !== undefined && typeof record.binary !== "string") {
    throw new Error("@plannotator/dsh config `binary` must be a string path to the plannotator CLI");
  }
  if (record.planReview !== undefined && typeof record.planReview !== "boolean") {
    throw new Error("@plannotator/dsh config `planReview` must be a boolean");
  }
  return {
    ...(typeof record.binary === "string" && record.binary.trim() && { binary: record.binary.trim() }),
    planReview: record.planReview !== false,
  };
}
