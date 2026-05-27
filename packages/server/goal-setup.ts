/**
 * Goal Setup Server
 *
 * Serves the Plannotator shell in a goal-setup mode for the setup-goal skill.
 * The interview and facts phases use the same endpoint surface so agents can
 * launch a browser session, wait, and receive a structured JSON result.
 */

import type { Origin } from "@plannotator/shared/agents";
import {
  createFactsResult,
  createInterviewResult,
  type GoalSetupBundle,
  type GoalSetupFactResult,
  type GoalSetupQuestionAnswer,
  type GoalSetupResult,
} from "@plannotator/shared/goal-setup";
import { getRepoInfo } from "./repo";
import {
  handleFavicon,
  handleImage,
  handleUpload,
} from "./shared-handlers";
import { detectGitUser, getServerConfig, saveConfig } from "./config";
import { isWSL } from "./browser";
import type { SessionRequestHandler } from "./session-handler";

export { handleServerReady as handleGoalSetupServerReady } from "./shared-handlers";


function coerceAnswers(body: unknown): GoalSetupQuestionAnswer[] {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  const answers = Array.isArray(record.answers)
    ? record.answers
    : record.result &&
        typeof record.result === "object" &&
        Array.isArray((record.result as Record<string, unknown>).answers)
      ? ((record.result as Record<string, unknown>).answers as unknown[])
      : [];
  return answers as GoalSetupQuestionAnswer[];
}

function coerceFacts(body: unknown): GoalSetupFactResult[] {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  const facts = Array.isArray(record.facts)
    ? record.facts
    : record.result &&
        typeof record.result === "object" &&
        Array.isArray((record.result as Record<string, unknown>).facts)
      ? ((record.result as Record<string, unknown>).facts as unknown[])
      : [];
  return facts as GoalSetupFactResult[];
}

export interface GoalSetupSessionOptions {
  cwd?: string;
  bundle: GoalSetupBundle;
  origin?: Origin;
}

export interface GoalSetupSession {
  handleRequest: SessionRequestHandler;
  waitForDecision: () => Promise<{ result?: GoalSetupResult; exit?: boolean }>;
  dispose: () => void;
}

export async function createGoalSetupSession(
  options: GoalSetupSessionOptions,
): Promise<GoalSetupSession> {
  const { cwd = process.cwd(), bundle, origin = "claude-code" } = options;
  const wslFlag = await isWSL();
  const repoInfo = await getRepoInfo(cwd);
  const gitUser = detectGitUser(cwd);

  let settled = false;
  let resolveDecision: (result: { result?: GoalSetupResult; exit?: boolean }) => void;
  const decisionPromise = new Promise<{ result?: GoalSetupResult; exit?: boolean }>((resolve) => {
    resolveDecision = resolve;
  });

  const resolveOnce = (result: { result?: GoalSetupResult; exit?: boolean }) => {
    if (settled) return;
    settled = true;
    resolveDecision(result);
  };

  const handleRequest: SessionRequestHandler = async (req, url) => {
    if ((url.pathname === "/api/plan" || url.pathname === "/api/goal-setup") && req.method === "GET") {
      return Response.json({
        plan: "",
        origin,
        mode: "goal-setup",
        goalSetup: bundle,
        repoInfo,
        projectRoot: cwd,
        isWSL: wslFlag,
        serverConfig: getServerConfig(gitUser),
        sharingEnabled: false,
      });
    }

    if (url.pathname === "/api/config" && req.method === "POST") {
      try {
        const body = (await req.json()) as {
          displayName?: string;
          diffOptions?: Record<string, unknown>;
          conventionalComments?: boolean;
          conventionalLabels?: unknown[] | null;
        };
        const toSave: Record<string, unknown> = {};
        if (body.displayName !== undefined) toSave.displayName = body.displayName;
        if (body.diffOptions !== undefined) toSave.diffOptions = body.diffOptions;
        if (body.conventionalComments !== undefined) toSave.conventionalComments = body.conventionalComments;
        if (body.conventionalLabels !== undefined) toSave.conventionalLabels = body.conventionalLabels;
        if (Object.keys(toSave).length > 0) saveConfig(toSave as Parameters<typeof saveConfig>[0]);
        return Response.json({ ok: true });
      } catch {
        return Response.json({ error: "Invalid request" }, { status: 400 });
      }
    }

    if (url.pathname === "/api/image") return handleImage(req);
    if (url.pathname === "/api/upload" && req.method === "POST") return handleUpload(req);

    if (url.pathname === "/api/goal-setup/submit" && req.method === "POST") {
      try {
        const body = await req.json();
        const result =
          bundle.stage === "interview"
            ? createInterviewResult(bundle, coerceAnswers(body))
            : createFactsResult(bundle, coerceFacts(body));
        resolveOnce({ result });
        return Response.json({ ok: true, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to submit result";
        return Response.json({ error: message }, { status: 400 });
      }
    }

    if (url.pathname === "/api/exit" && req.method === "POST") {
      resolveOnce({ exit: true });
      return Response.json({ ok: true });
    }

    if (url.pathname === "/favicon.svg") return handleFavicon();

    return new Response("Not found", { status: 404 });
  };

  return {
    handleRequest,
    waitForDecision: () => decisionPromise,
    dispose: () => resolveOnce({ exit: true }),
  };
}
