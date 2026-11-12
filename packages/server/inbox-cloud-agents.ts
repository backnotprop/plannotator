/**
 * Paired cloud agents (step 1 of "Pair a cloud agent"; the wake is
 * inbox-cloud-wake.ts, the pure parts @plannotator/core/inbox-cloud).
 *
 * Each agent's webhook address and key live in `inbox/cloud-agents.json`
 * (0600), never in config.json, a log, an error, an event frame or an API
 * answer: the window only learns that a key is set. Remove deletes the entry,
 * key and address included, and revokes its agent device, at once.
 *
 * The window's routes, the owner's alone (this computer, or the owner's login
 * over the tailnet; never a tailnet guest, another site's page or the phone's
 * door, whose allowlist has no settings route):
 *
 *   GET  /api/inbox/cloud-agents                   `{ agents, projects }`
 *   POST /api/inbox/cloud-agents                   `{ name, preset, url, key, project_id? }`: pair; answers the pairing string once
 *   POST /api/inbox/cloud-agents/:session/test     fire the webhook once: `{ test: { started, run_url?, words } }`
 *   POST /api/inbox/cloud-agents/:session/key      `{ key }`: a new key; held wakes go again
 *   POST /api/inbox/cloud-agents/:session/remove   unpair: the key is deleted at once
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  INBOX_CLOUD_PRESET_NAMES,
  inboxCloudAnswer,
  inboxCloudRelayHost,
  inboxCloudSetup,
  inboxCloudStatusWords,
  inboxCloudTestBody,
  isInboxCloudPreset,
  isInboxCloudSession,
  type InboxCloudAgentView,
  type InboxCloudLink,
  type InboxCloudPreset,
  type InboxCloudSetup,
} from "@plannotator/core/inbox-cloud";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import { encodeInboxAgentPairing } from "@plannotator/shared/inbox/agent-pairing";
import type { InboxDevice } from "@plannotator/shared/inbox/devices";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { writeAgentFileAtomic } from "./agent-files";
import { postCloudWebhook } from "./inbox-cloud-post";

export const INBOX_CLOUD_AGENTS_FILE = "cloud-agents.json";

/** One paired agent as stored (0600). `url` and `key` never leave this module except in the wake's request. */
export interface InboxCloudAgent {
  session: string;
  name: string;
  preset: InboxCloudPreset;
  url: string | null;
  key: string | null;
  project_id: string | null;
  created_at: string;
  key_set_at: string | null;
  key_rejected_at: string | null;
  /** Its device (inbox/devices.jsonl, platform `agent`): the agent door's token hash and secret live there. */
  device_id?: string;
  relay?: boolean;
  connected_at?: string | null;
}

export type InboxCloudWakeAgent = InboxCloudAgent & { url: string; key: string };

export function hasCloudWake(agent: InboxCloudAgent): agent is InboxCloudWakeAgent {
  return typeof agent.url === "string" && agent.url !== "" && typeof agent.key === "string" && agent.key !== "";
}

interface CloudAgentsFile {
  v: 1;
  agents: InboxCloudAgent[];
}

export const cloudAgentsPath = (dataDir: string) => join(inboxDir(dataDir), INBOX_CLOUD_AGENTS_FILE);

export function readCloudAgents(dataDir: string): InboxCloudAgent[] {
  const path = cloudAgentsPath(dataDir);
  if (!existsSync(path)) return [];
  try {
    const file = JSON.parse(readFileSync(path, "utf8")) as Partial<CloudAgentsFile>;
    return (Array.isArray(file.agents) ? file.agents : []).filter(
      (agent): agent is InboxCloudAgent => !!agent && isInboxCloudSession(agent.session) && isInboxCloudPreset(agent.preset) && (agent.url === null || typeof agent.url === "string") && (agent.key === null || typeof agent.key === "string"),
    );
  } catch {
    return [];
  }
}

function writeCloudAgents(dataDir: string, agents: InboxCloudAgent[]): void {
  const file: CloudAgentsFile = { v: 1, agents };
  writeAgentFileAtomic(cloudAgentsPath(dataDir), `${JSON.stringify(file, null, 2)}\n`, 0o600);
}

/** A webhook address the Inbox may POST a key to: https, or http on this computer only (a local stub). */
export function cloudWebhookUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return url;
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]") ? url : null;
}

/** A pasted key, trimmed: "Bearer " pasted along is dropped; no spaces or line breaks inside. */
export function cloudKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim().replace(/^Authorization:\s*/i, "").replace(/^Bearer\s+/i, "").trim();
  return key && key.length <= 4096 && !/\s/.test(key) ? key : null;
}

export class CloudAgentError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

export function createInboxCloudAgents(options: {
  store: InboxStore;
  dataDir: string;
  now?: () => Date;
  /** A wake engine's hooks: an agent was paired, re-keyed or removed. */
  onChange?: (agents: InboxCloudAgent[]) => void;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** The device door's agent devices (inbox-devices.ts), bound once the door exists. */
  devices?: () => {
    mint: (name: string) => { device: InboxDevice; token: string; secret: string };
    relay: (device: InboxDevice) => Promise<{ url: string; mailbox_id: string } | null>;
    revoke: (id: string) => void;
    seenAt?: (id: string) => string | null;
  } | null;
  relayUp?: () => boolean | null;
}) {
  const { store, dataDir } = options;
  const now = options.now ?? (() => new Date());
  let agents = readCloudAgents(dataDir);

  const save = (next: InboxCloudAgent[]) => {
    writeCloudAgents(dataDir, next);
    agents = next;
    options.onChange?.(agents);
  };

  const projectName = (id: string | null) => {
    const project = id ? store.project(store.canonicalProjectId(id)) : null;
    return project ? { id: project.id, name: project.display_name ?? project.name } : null;
  };

  const link = (agent: InboxCloudAgent): InboxCloudLink => {
    const connected = agent.connected_at ?? null;
    const seen = agent.device_id ? (options.devices?.()?.seenAt?.(agent.device_id) ?? null) : null;
    const lastSeen = connected && seen && seen > connected ? seen : connected;
    if (agent.relay && options.relayUp?.() === false) return { state: "relay_down", last_seen_at: lastSeen };
    if (connected) return { state: "connected", last_seen_at: lastSeen };
    if (!agent.relay) return { state: "no_relay", last_seen_at: null };
    return { state: "waiting", last_seen_at: null };
  };

  const view = (agent: InboxCloudAgent): InboxCloudAgentView => ({
    session: agent.session,
    name: agent.name,
    preset: agent.preset,
    project: projectName(agent.project_id),
    created_at: agent.created_at,
    wake: hasCloudWake(agent),
    key_rejected_at: agent.key_rejected_at,
    link: link(agent),
  });

  /** The projects a person sees, the most recently active first (the pair form's list). */
  const projects = () =>
    store
      .listProjects()
      .map((project) => ({ id: project.id, name: project.display_name ?? project.name, last: store.threadsOf(project.id).reduce((max, t) => (t.last_at > max ? t.last_at : max), project.created_at) }))
      .sort((a, b) => b.last.localeCompare(a.last))
      .map(({ id, name }) => ({ id, name }));

  const find = (session: string) => {
    const agent = agents.find((candidate) => candidate.session === session);
    if (!agent) throw new CloudAgentError("cloud_agent_not_found", "That cloud agent is not paired any more.");
    return agent;
  };

  const webhookOf = (body: Record<string, unknown>, required: boolean): { url: string; key: string } | null => {
    const given = (typeof body.url === "string" && body.url.trim() !== "") || (typeof body.key === "string" && body.key.trim() !== "");
    if (!given && !required) return null;
    const url = cloudWebhookUrl(body.url);
    if (!url) throw new CloudAgentError("validation_error", "Paste the routine's webhook address (it starts with https://).", "url");
    const key = cloudKey(body.key);
    if (!key) throw new CloudAgentError("validation_error", "Paste the routine's key.", "key");
    return { url: url.href, key };
  };

  const mintPairing = async (name: string, preset: InboxCloudPreset): Promise<{ device_id?: string; relay: boolean; setup: InboxCloudSetup | null; pairing: string | null }> => {
    const devices = options.devices?.() ?? null;
    const minted = devices?.mint(name) ?? null;
    if (!minted || !devices) return { relay: false, setup: null, pairing: null };
    const relay = await devices.relay(minted.device).catch(() => null);
    const pairing = encodeInboxAgentPairing({ device_id: minted.device.id, token: minted.token, secret: minted.secret, ...(relay ? { relay } : {}) });
    return { device_id: minted.device.id, relay: relay !== null, setup: relay ? inboxCloudSetup(preset, pairing, inboxCloudRelayHost(relay.url)) : null, pairing };
  };

  const pair = async (body: Record<string, unknown>): Promise<{ agent: InboxCloudAgent; pairing: string | null; setup: InboxCloudSetup | null }> => {
    const name = typeof body.name === "string" ? body.name.replace(/\s+/g, " ").trim() : "";
    if (!name || name.length > 60) throw new CloudAgentError("validation_error", "Give it a name (up to 60 characters).", "name");
    if (!isInboxCloudPreset(body.preset)) throw new CloudAgentError("validation_error", "Pick what kind of agent it is.", "preset");
    const preset = body.preset;
    const webhook = webhookOf(body, false);
    const listed = projects();
    const projectId = typeof body.project_id === "string" && listed.some((p) => p.id === body.project_id) ? body.project_id : (listed[0]?.id ?? null);
    const at = now().toISOString();
    const minted = await mintPairing(name, preset);
    const agent: InboxCloudAgent = {
      session: `cloud.${randomBytes(6).toString("hex")}`,
      name,
      preset,
      url: webhook?.url ?? null,
      key: webhook?.key ?? null,
      project_id: projectId,
      created_at: at,
      key_set_at: webhook ? at : null,
      key_rejected_at: null,
      ...(minted.device_id ? { device_id: minted.device_id } : {}),
      relay: minted.relay,
      connected_at: null,
    };
    save([...agents, agent]);
    return { agent, pairing: minted.pairing, setup: minted.setup };
  };

  const repair = async (session: string): Promise<{ agent: InboxCloudAgent; pairing: string | null; setup: InboxCloudSetup | null }> => {
    const agent = find(session);
    if (agent.device_id) options.devices?.()?.revoke(agent.device_id);
    const minted = await mintPairing(agent.name, agent.preset);
    const { device_id: _old, ...rest } = agent;
    const next: InboxCloudAgent = { ...rest, ...(minted.device_id ? { device_id: minted.device_id } : {}), relay: minted.relay, connected_at: null };
    save(agents.map((candidate) => (candidate.session === session ? next : candidate)));
    return { agent: next, pairing: minted.pairing, setup: minted.setup };
  };

  const setWake = (session: string, body: Record<string, unknown>): InboxCloudAgent => {
    const agent = find(session);
    const webhook = webhookOf(body, true)!;
    const next = { ...agent, url: webhook.url, key: webhook.key, key_set_at: now().toISOString(), key_rejected_at: null };
    save(agents.map((candidate) => (candidate.session === session ? next : candidate)));
    return next;
  };

  const seen = (deviceId: string) => {
    const agent = agents.find((candidate) => candidate.device_id === deviceId);
    if (!agent || agent.connected_at) return;
    save(agents.map((candidate) => (candidate === agent ? { ...candidate, connected_at: now().toISOString() } : candidate)));
  };

  const rekey = (session: string, body: Record<string, unknown>): InboxCloudAgent => {
    const agent = find(session);
    const key = cloudKey(body.key);
    if (!key) throw new CloudAgentError("validation_error", "Paste the routine's new key.", "key");
    const next = { ...agent, key, key_set_at: now().toISOString(), key_rejected_at: null };
    save(agents.map((candidate) => (candidate.session === session ? next : candidate)));
    return next;
  };

  const remove = (session: string): boolean => {
    const agent = agents.find((candidate) => candidate.session === session);
    if (!agent) return false;
    if (agent.device_id) options.devices?.()?.revoke(agent.device_id);
    save(agents.filter((candidate) => candidate.session !== session));
    return true;
  };

  /** The routine refused the key: said once, on the agent, until a new key is pasted. */
  const markKeyRejected = (session: string) => {
    const agent = agents.find((candidate) => candidate.session === session);
    if (!agent || agent.key_rejected_at) return;
    save(agents.map((candidate) => (candidate.session === session ? { ...candidate, key_rejected_at: now().toISOString() } : candidate)));
  };

  /** Settings' Send a test: one POST, and plain words for what happened. Never the address, the key or the routine's own words. */
  const test = async (session: string): Promise<{ started: boolean; run_url?: string; words: string }> => {
    const agent = find(session);
    if (!hasCloudWake(agent)) return { started: false, words: "Add its wake address first." };
    const sent = await postCloudWebhook(agent, inboxCloudTestBody(agent.preset, agent.name), { fetch: options.fetch, timeoutMs: options.timeoutMs });
    if (sent.kind === "timeout") return { started: false, words: "No answer in time. A run may have started; check the routine." };
    if (sent.kind === "unreachable") return { started: false, words: "Could not reach that address. Check it, and that this computer is online." };
    const answer = inboxCloudAnswer(agent.preset, sent.status, sent.retryAfter, sent.body, now().getTime());
    switch (answer.kind) {
      case "started":
        if (agent.key_rejected_at) save(agents.map((candidate) => (candidate.session === session ? { ...candidate, key_rejected_at: null } : candidate)));
        return {
          started: true,
          ...(answer.run_url ? { run_url: answer.run_url } : {}),
          words: agent.preset === "grok-bot" ? "A run started. See Grok Bot's chat." : "A run started.",
        };
      case "key_rejected":
        markKeyRejected(session);
        return { started: false, words: "The routine refused the key. Paste the new key." };
      case "rate_limited":
        return { started: false, words: `The routine is at its hourly limit. Try again in ${Math.max(1, Math.round(answer.wait_ms / 60_000))} min.` };
      default:
        return { started: false, words: `No run started: ${inboxCloudStatusWords(answer.status)}.` };
    }
  };

  return {
    list: () => agents,
    agent: (session: string) => agents.find((agent) => agent.session === session) ?? null,
    byDevice: (deviceId: string) => agents.find((agent) => agent.device_id === deviceId) ?? null,
    view,
    projects,
    pair,
    repair,
    setWake,
    seen,
    rekey,
    remove,
    test,
    markKeyRejected,
    presetName: (preset: InboxCloudPreset) => INBOX_CLOUD_PRESET_NAMES[preset],
  };
}

export type InboxCloudAgents = ReturnType<typeof createInboxCloudAgents>;
