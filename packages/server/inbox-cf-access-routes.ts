import { randomBytes } from "node:crypto";
import { loadConfig } from "@plannotator/shared/config";
import { storedCfAccess } from "@plannotator/shared/inbox/cf-access";
import { createCfApi, CfApiError, type CfApi } from "@plannotator/shared/inbox/cf-access-api";
import type { EdgeFetch } from "./cf-access-checks";
import { CF_FLOW_STEPS, runCfAccessRemoveFlow, runCfAccessSetupFlow, setCfAccessOn, type CfFlowStep } from "./cf-access-flow";
import { cloudflaredInstallHint, findCloudflared } from "./cf-tunnel";
import type { InboxCfAccessState } from "./inbox-cf-access";

export const CF_ACCESS_ROUTE = "/api/inbox/cloudflare-access";

export interface CfAccessRouteHooks {
  api?: (token: string) => CfApi;
  binary?: string | null;
  edgeFetch?: EdgeFetch;
  checkTimeoutMs?: number;
  connectTimeoutMs?: number;
  pickPort?: () => number;
}

export interface CfAccessRoutesContext {
  dataDir: string;
  door: { restart: () => void; state: () => InboxCfAccessState } | null;
  json: (body: unknown, status?: number) => Response;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  sessionMismatch: (body: Record<string, unknown>) => Response | null;
  hooks?: CfAccessRouteHooks;
}

type StepState = "pending" | "running" | "done" | "failed";

interface Job {
  running: boolean;
  steps: { id: CfFlowStep; state: StepState }[];
  host: string | null;
  failed: { step: CfFlowStep; message: string; leftover: string[] } | null;
}

function freePort(): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = server.port as number;
  server.stop(true);
  return port;
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export function createCfAccessRoutes(context: CfAccessRoutesContext) {
  const hooks = context.hooks ?? {};
  const makeApi = hooks.api ?? ((token: string) => createCfApi(token));
  const binary = () => (hooks.binary === undefined ? findCloudflared() : hooks.binary);
  let job: Job | null = null;
  const apply = () => context.door?.restart();

  const view = () => {
    const stored = storedCfAccess(loadConfig());
    const door = context.door?.state() ?? null;
    return {
      configured: Boolean(stored?.host && stored.aud),
      on: stored?.on === true,
      host: stored?.host ?? null,
      session_host: stored?.sessionHost ?? null,
      allowed: stored?.allow ?? [],
      url: door?.url ?? null,
      sessions_url: door?.sessionsUrl ?? null,
      error: door?.error ?? null,
      tunnel: door?.tunnel ?? null,
      cloudflared: { found: binary() !== null, install: cloudflaredInstallHint() },
      job: job ? { running: job.running, steps: job.steps, host: job.host, failed: job.failed } : null,
    };
  };

  const refuse = (message: string, code: string, status = 400) => context.json({ error: message, code }, status);
  const apiFailure = (error: unknown) =>
    error instanceof CfApiError ? refuse(error.message, "cloudflare_refused", 502) : refuse("Cloudflare could not be reached.", "cloudflare_unreachable", 502);

  const zones = async (token: string) => {
    const api = makeApi(token);
    const verified = await api.call<{ status?: string }>("GET", "/user/tokens/verify");
    if (verified?.status !== "active") throw new CfApiError("The API token is not active.");
    const list = await api.call<{ id: string; name: string; account?: { id?: string; name?: string } }[]>("GET", "/zones?per_page=50");
    return list.map((zone) => ({ name: zone.name, account: zone.account?.id ?? null }));
  };

  const startSetup = (token: string, input: { email: string; zone: string; account: string | null; hostname: string }) => {
    const path = binary();
    const run: Job = { running: true, steps: CF_FLOW_STEPS.map((id) => ({ id, state: "pending" })), host: input.hostname, failed: null };
    job = run;
    const stored = storedCfAccess(loadConfig());
    const port = stored?.port ?? (hooks.pickPort ?? freePort)();
    void runCfAccessSetupFlow(
      { dataDir: context.dataDir, api: makeApi(token), binary: path!, apply, edgeFetch: hooks.edgeFetch, checkTimeoutMs: hooks.checkTimeoutMs, connectTimeoutMs: hooks.connectTimeoutMs },
      { email: input.email, port, zone: input.zone, hostname: input.hostname, ...(input.account ? { account: input.account } : {}) },
      (step, state) => {
        const entry = run.steps.find((s) => s.id === step);
        if (entry) entry.state = state;
      },
    ).then(
      (result) => {
        run.running = false;
        if (!result.ok) {
          const entry = run.steps.find((s) => s.id === result.step);
          if (entry) entry.state = "failed";
          run.failed = { step: result.step, message: result.message, leftover: result.leftover };
        }
      },
      () => {
        run.running = false;
        run.failed = { step: "account", message: "Setup stopped unexpectedly.", leftover: [] };
      },
    );
  };

  const handle = async (req: Request, path: string): Promise<Response | null> => {
    if (path === CF_ACCESS_ROUTE) {
      if (req.method !== "GET") return context.json({ error: "Use GET." }, 405);
      return context.json(view());
    }
    if (!path.startsWith(`${CF_ACCESS_ROUTE}/`)) return null;
    if (req.method !== "POST") return context.json({ error: "Use POST." }, 405);
    const body = await context.readBody(req);
    const mismatch = context.sessionMismatch(body);
    if (mismatch) return mismatch;
    const action = path.slice(CF_ACCESS_ROUTE.length + 1);
    const token = text(body.token);
    delete body.token;

    if (action === "zones") {
      if (!token) return refuse("Paste a Cloudflare API token.", "token_required");
      try {
        const list = await zones(token);
        return context.json({ zones: list, label: `plannotator-${randomBytes(3).toString("hex")}` });
      } catch (error) {
        return apiFailure(error);
      }
    }

    if (action === "setup") {
      if (job?.running) return refuse("Setup is already running.", "setup_running", 409);
      if (!token) return refuse("Paste a Cloudflare API token.", "token_required");
      const email = text(body.email).toLowerCase();
      if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(email)) return refuse("Type the e-mail that may sign in.", "email_required");
      const zone = text(body.zone).toLowerCase();
      const hostname = text(body.hostname).toLowerCase();
      if (!zone || !hostname.endsWith(`.${zone}`)) return refuse("Pick the domain to use.", "zone_required");
      if (binary() === null) return refuse(`cloudflared is not installed. ${cloudflaredInstallHint()}`, "cloudflared_missing");
      startSetup(token, { email, zone, account: text(body.account) || null, hostname });
      return context.json(view(), 202);
    }

    if (action === "switch") {
      if (job?.running) return refuse("Setup is running.", "setup_running", 409);
      if (!setCfAccessOn(body.on === true)) return refuse("Cloudflare is not set up.", "not_set_up", 409);
      apply();
      return context.json(view());
    }

    if (action === "remove") {
      if (job?.running) return refuse("Setup is running.", "setup_running", 409);
      if (!token) return refuse("Removing needs the API token again.", "token_required");
      const removed = await runCfAccessRemoveFlow({ dataDir: context.dataDir, api: makeApi(token), apply });
      if (!removed.ok) return context.json({ ...view(), error: removed.message }, 502);
      job = null;
      return context.json(view());
    }

    if (action === "dismiss") {
      if (!job?.running) job = null;
      return context.json(view());
    }

    return context.json({ error: "Unknown Cloudflare action.", code: "unknown_action" }, 404);
  };

  return { handle };
}
