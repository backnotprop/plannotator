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
import { isRemoteSession, getServerHostname, getServerPort } from "./remote";
import { getRepoInfo } from "./repo";
import {
  handleFavicon,
  handleImage,
  handleServerReady,
  handleUpload,
} from "./shared-handlers";
import { detectGitUser, getServerConfig, saveConfig } from "./config";
import { isWSL } from "./browser";

export { handleServerReady as handleGoalSetupServerReady } from "./shared-handlers";

export interface GoalSetupServerOptions {
  bundle: GoalSetupBundle;
  htmlContent: string;
  origin?: Origin;
  onReady?: (url: string, isRemote: boolean, port: number) => void;
}

export interface GoalSetupServerResult {
  port: number;
  url: string;
  isRemote: boolean;
  waitForDecision: () => Promise<{
    result?: GoalSetupResult;
    exit?: boolean;
  }>;
  stop: () => void;
}

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 500;

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

export async function startGoalSetupServer(
  options: GoalSetupServerOptions
): Promise<GoalSetupServerResult> {
  const { bundle, htmlContent, origin = "claude-code", onReady } = options;
  const isRemote = isRemoteSession();
  const configuredPort = getServerPort();
  const wslFlag = await isWSL();
  const repoInfo = await getRepoInfo();
  const gitUser = detectGitUser();

  let settled = false;
  let resolveDecision: (result: {
    result?: GoalSetupResult;
    exit?: boolean;
  }) => void;
  const decisionPromise = new Promise<{
    result?: GoalSetupResult;
    exit?: boolean;
  }>((resolve) => {
    resolveDecision = resolve;
  });

  const resolveOnce = (result: { result?: GoalSetupResult; exit?: boolean }) => {
    if (settled) return;
    settled = true;
    resolveDecision(result);
  };

  let server: ReturnType<typeof Bun.serve> | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      server = Bun.serve({
        hostname: getServerHostname(),
        port: configuredPort,
        // Bun's default 10s idleTimeout kills long-running requests.
        idleTimeout: 0,

        async fetch(req) {
          const url = new URL(req.url);

          if (
            (url.pathname === "/api/plan" ||
              url.pathname === "/api/goal-setup") &&
            req.method === "GET"
          ) {
            return Response.json({
              plan: "",
              origin,
              mode: "goal-setup",
              goalSetup: bundle,
              repoInfo,
              projectRoot: process.cwd(),
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
              if (body.displayName !== undefined) {
                toSave.displayName = body.displayName;
              }
              if (body.diffOptions !== undefined) {
                toSave.diffOptions = body.diffOptions;
              }
              if (body.conventionalComments !== undefined) {
                toSave.conventionalComments = body.conventionalComments;
              }
              if (body.conventionalLabels !== undefined) {
                toSave.conventionalLabels = body.conventionalLabels;
              }
              if (Object.keys(toSave).length > 0) {
                saveConfig(toSave as Parameters<typeof saveConfig>[0]);
              }
              return Response.json({ ok: true });
            } catch {
              return Response.json({ error: "Invalid request" }, { status: 400 });
            }
          }

          if (url.pathname === "/api/image") return handleImage(req);
          if (url.pathname === "/api/upload" && req.method === "POST") {
            return handleUpload(req);
          }

          if (
            url.pathname === "/api/goal-setup/submit" &&
            req.method === "POST"
          ) {
            try {
              const body = await req.json();
              const result =
                bundle.stage === "interview"
                  ? createInterviewResult(bundle, coerceAnswers(body))
                  : createFactsResult(bundle, coerceFacts(body));
              resolveOnce({ result });
              return Response.json({ ok: true, result });
            } catch (err) {
              const message =
                err instanceof Error ? err.message : "Failed to submit result";
              return Response.json({ error: message }, { status: 400 });
            }
          }

          if (url.pathname === "/api/exit" && req.method === "POST") {
            resolveOnce({ exit: true });
            return Response.json({ ok: true });
          }

          if (url.pathname === "/favicon.svg") return handleFavicon();

          return new Response(htmlContent, {
            headers: { "Content-Type": "text/html" },
          });
        },

        error(err) {
          console.error("[plannotator] Goal setup server error:", err);
          return new Response(
            `Internal Server Error: ${err instanceof Error ? err.message : String(err)}`,
            { status: 500, headers: { "Content-Type": "text/plain" } }
          );
        },
      });

      break;
    } catch (err: unknown) {
      const isAddressInUse =
        err instanceof Error && err.message.includes("EADDRINUSE");

      if (isAddressInUse && attempt < MAX_RETRIES) {
        await Bun.sleep(RETRY_DELAY_MS);
        continue;
      }

      if (isAddressInUse) {
        const hint = isRemote
          ? " (set PLANNOTATOR_PORT to use different port)"
          : "";
        throw new Error(
          `Port ${configuredPort} in use after ${MAX_RETRIES} retries${hint}`
        );
      }

      throw err;
    }
  }

  if (!server) {
    throw new Error("Failed to start goal setup server");
  }

  const port = server.port!;
  const serverUrl = `http://localhost:${port}`;
  onReady?.(serverUrl, isRemote, port);

  return {
    port,
    url: serverUrl,
    isRemote,
    waitForDecision: () => decisionPromise,
    stop: () => server.stop(),
  };
}
