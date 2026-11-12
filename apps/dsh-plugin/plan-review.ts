import { randomUUID } from "node:crypto";
import { resolvePlannotatorBinary, runDshPlan, type DshPlanResult } from "./cli";

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

export interface DshContext {
  on(
    event: "user-questions/request",
    listener: (request: DshQuestionRequest, next: () => Promise<DshAnswer>) => Promise<DshAnswer>,
    options?: { prepend?: boolean },
  ): unknown;
  get?(name: string): unknown;
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
  unloadSignal?: AbortSignal;
}

function anySignal(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return present.length > 1 ? AbortSignal.any(present) : present[0];
}

export function planReviewQuestion(request: DshQuestionRequest | undefined): (DshQuestion & { detail: string; intent: { kind: "plan-review"; approve: string } }) | undefined {
  const questions = request?.questions;
  if (!Array.isArray(questions) || questions.length !== 1) return undefined;
  const question = questions[0];
  if (question?.intent?.kind !== "plan-review" || typeof question.intent.approve !== "string") return undefined;
  if (typeof question.detail !== "string" || !question.detail.trim()) return undefined;
  return question as DshQuestion & { detail: string; intent: { kind: "plan-review"; approve: string } };
}

export function sessionCwd(ctx: DshContext, agent: DshAgent | undefined): string | undefined {
  if (!agent) return undefined;
  try {
    const workingDirectory = ctx.get?.("workingDirectory") as { get?(session: unknown): unknown } | undefined;
    const current = workingDirectory?.get?.(agent.session);
    if (typeof current === "string" && current) return current;
  } catch {
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
        onStderr: (chunk) => {
          for (const line of chunk.split(/\r?\n/)) {
            if (URL_RE.test(line)) {
              try {
                ctx.logger?.info?.("plannotator: %s", line.trim());
              } catch {
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
