import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig, saveConfig } from "@plannotator/shared/config";
import { storedCfAccess, type CfAccessStored } from "@plannotator/shared/inbox/cf-access";
import { normalizeCfSetupHostname, runCfSetup, runCfTeardown, type CfApi, type CfSetupInput, type CfSetupStep, type CfTeardownIds, type CfTeardownStep } from "@plannotator/shared/inbox/cf-access-api";
import { runOutsideChecks, type EdgeFetch } from "./cf-access-checks";
import { tunnelTokenPath } from "./cf-tunnel";

export type CfFlowStep = "account" | "tunnel" | "gate" | "address" | "checks";
export const CF_FLOW_STEPS: readonly CfFlowStep[] = ["account", "tunnel", "gate", "address", "checks"];

const NEXT_AFTER: Partial<Record<CfSetupStep, CfFlowStep>> = { idp: "tunnel", ingress: "gate", app: "address" };

export interface CfFlowDeps {
  dataDir: string;
  api: CfApi;
  binary: string;
  apply: () => unknown;
  edgeFetch?: EdgeFetch;
  checkTimeoutMs?: number;
  connectTimeoutMs?: number;
}

export type CfFlowResult =
  | { ok: true; host: string; sessionHost: string; email: string }
  | { ok: false; step: CfFlowStep; message: string; leftover: string[] };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function leftoverOf(ids: CfTeardownIds): string[] {
  return [
    ...(ids.dnsRecord ? [`DNS record ${ids.dnsRecord}`] : []),
    ...(ids.sessionDnsRecord ? [`DNS record ${ids.sessionDnsRecord}`] : []),
    ...(ids.app ? [`Access application ${ids.app}`] : []),
    ...(ids.tunnel ? [`tunnel ${ids.tunnel}`] : []),
  ];
}

export async function runCfAccessSetupFlow(
  deps: CfFlowDeps,
  input: CfSetupInput,
  onStep: (step: CfFlowStep, state: "running" | "done", detail?: string) => void = () => {},
  onSetupStep: (step: CfSetupStep, detail?: string) => void = () => {},
): Promise<CfFlowResult> {
  const before = storedCfAccess(loadConfig());
  const tokenFile = tunnelTokenPath(deps.dataDir);
  const tokenBefore = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8") : null;
  const created: CfTeardownIds = {};
  let current: CfFlowStep = "account";

  const fail = async (step: CfFlowStep, message: string): Promise<CfFlowResult> => {
    let leftover: string[] = [];
    try {
      await runCfTeardown(deps.api, created);
    } catch {
      leftover = leftoverOf(created);
    }
    if (tokenBefore === null) rmSync(tokenFile, { force: true });
    else writeFileSync(tokenFile, tokenBefore, { mode: 0o600 });
    saveConfig({ inboxCloudflareAccess: before ?? undefined });
    await deps.apply();
    return { ok: false, step, message, leftover };
  };

  if (before?.on) {
    saveConfig({ inboxCloudflareAccess: { ...before, on: false } });
    await deps.apply();
  }
  onStep(current, "running");
  let result;
  try {
    const host = normalizeCfSetupHostname(input.hostname ?? "");
    const reusingHost = host !== "" && typeof before?.host === "string" && normalizeCfSetupHostname(before.host) === host;
    const previousSessionHost = reusingHost && typeof before.sessionHost === "string" ? normalizeCfSetupHostname(before.sessionHost) : "";
    result = await runCfSetup(
      deps.api,
      { ...input, sessionHostname: input.sessionHostname ?? (previousSessionHost || undefined) },
      (step, detail) => {
        onSetupStep(step, detail);
        const next = NEXT_AFTER[step];
        if (!next) return;
        onStep(current, "done");
        current = next;
        onStep(current, "running", detail);
      },
      created,
    );
  } catch (error) {
    return fail(current, messageOf(error));
  }
  onStep(current, "done", result.host);

  mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
  writeFileSync(tokenFile, result.tunnelToken, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
  const email = input.email.trim().toLowerCase();
  const stored: CfAccessStored = {
    on: false,
    host: result.host,
    sessionHost: result.sessionHost,
    team: result.team,
    aud: result.aud,
    allow: [email],
    port: input.port,
    account: result.account,
    zone: result.zone,
    tunnel: result.tunnel,
    app: result.app,
    dnsRecord: result.dnsRecord,
    sessionDnsRecord: result.sessionDnsRecord,
  };
  saveConfig({ inboxCloudflareAccess: stored });

  current = "checks";
  onStep(current, "running");
  const checked = await runOutsideChecks({
    hosts: [result.host, result.sessionHost],
    team: result.team,
    port: input.port,
    binary: deps.binary,
    tokenFile,
    edgeFetch: deps.edgeFetch,
    timeoutMs: deps.checkTimeoutMs,
    connectTimeoutMs: deps.connectTimeoutMs,
  });
  if (!checked.ok) return fail("checks", checked.failure);
  saveConfig({ inboxCloudflareAccess: { ...stored, on: true } });
  await deps.apply();
  onStep(current, "done");
  return { ok: true, host: result.host, sessionHost: result.sessionHost, email };
}

export async function runCfAccessRemoveFlow(
  deps: Pick<CfFlowDeps, "dataDir" | "api" | "apply">,
  onStep: (step: CfTeardownStep) => void = () => {},
): Promise<{ ok: true } | { ok: false; message: string }> {
  const stored = storedCfAccess(loadConfig());
  if (!stored) return { ok: true };
  saveConfig({ inboxCloudflareAccess: { ...stored, on: false } });
  await deps.apply();
  try {
    await runCfTeardown(deps.api, stored, onStep);
  } catch (error) {
    return { ok: false, message: `${messageOf(error)}. It is off here; try Remove again to finish.` };
  }
  rmSync(tunnelTokenPath(deps.dataDir), { force: true });
  saveConfig({ inboxCloudflareAccess: undefined });
  await deps.apply();
  return { ok: true };
}

export function setCfAccessOn(on: boolean): boolean {
  const stored = storedCfAccess(loadConfig());
  if (!stored?.host || !stored.aud) return false;
  saveConfig({ inboxCloudflareAccess: { ...stored, on } });
  return true;
}
