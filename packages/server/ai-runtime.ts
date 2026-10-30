import { childPath } from "@plannotator/shared/child-env";
import {
  createAIEndpoints,
  createPullSessionBridge,
  takePullSessionBridgeConfig,
  createDeferredModelDiscovery,
  createProvider,
  ProviderRegistry,
  SESSION_BRIDGE_PROVIDER_NAME,
  SessionBridgeProvider,
  SessionManager,
  type AIEndpoints,
  type PiSDKConfig,
  type PullSessionBridgeConfig,
  type QwenSDKConfig,
  type SessionBridge,
  type SessionBridgeHost,
} from "@plannotator/ai";
import { resolveWindowsCommandShim } from "@plannotator/ai/providers/command-path";
import { isLoopbackHostHeader } from "@plannotator/shared/loopback-host";
import { cameThroughTailscale } from "@plannotator/shared/tailnet-audience";
import { getLocalUrlHostname, isRemoteSession } from "./remote";
import type { SessionTailnetGate } from "./session-tailnet";

export interface AIRuntime {
  endpoints: AIEndpoints;
  dispose: () => void;
}

export const AI_QUERY_ENDPOINT = "/api/ai/query";

interface CreateAIRuntimeOptions {
  cwd?: string;
  getCwd?: () => string;
  /**
   * "Ask this session": a host that can answer Ask AI from the agent session
   * that opened Plannotator passes its bridge here. With a bridge it is the
   * ONLY Ask AI provider: SDK providers serve model catalogs to the agent-job
   * launchers but are never offered or reachable for Ask AI.
   */
  sessionBridge?: SessionBridge;
  /**
   * The port this server listens on, once bound. Required for the bridge to
   * answer: its requests must carry a loopback Host with exactly this port
   * (DNS-rebinding guard). Undefined (not bound yet) refuses bridge requests.
   */
  getServerPort?: () => number | undefined;
  /**
   * The localhost subdomain this session is advertised at (#2184): a page
   * there asks with that Host, so the bridge accepts it beside the loopback
   * names. Defaults to the configured one (getLocalUrlHostname), read here
   * once; null accepts none.
   */
  localHostname?: string | null;
  /**
   * "Ask this session" for a host that launched this server as a SEPARATE
   * process (the OpenCode plugin, the Claude Code mod): the host long-polls
   * `/api/ai/bridge/poll` with this token (session-bridge-pull.ts). Defaults to
   * the config the host put in the environment (`PLANNOTATOR_SESSION_BRIDGE_*`),
   * taken once per process and removed from `process.env`. Ignored when an
   * in-process `sessionBridge` is given, and off in remote mode. Like the
   * in-process bridge, it is then the only Ask AI provider.
   */
  pullSessionBridge?: PullSessionBridgeConfig | null;
  /**
   * A session published with `--tailscale` (#2166): who sent each request
   * (session-tailnet.ts). With a bridge, a tab on this machine and the
   * owner's tab through `tailscale serve` get "Ask this session"; every other
   * tailnet request is answered by a second set of endpoints over the SDK
   * providers only (what a `--tailscale` session always served), with its own
   * sessions, and the bridge's poll answers this machine only. Without a
   * bridge it changes nothing. Absent: every request is treated as today.
   */
  tailnet?: SessionTailnetGate;
}

let envPullBridgeTaken = false;
let envPullBridge: PullSessionBridgeConfig | undefined;
/** The host named by a valid pull-bridge config, kept even after a discard. */
let envLaunchingHost: SessionBridgeHost | undefined;

/**
 * The pull-bridge config from the environment, read once per process. Taking
 * it also deletes the variables, so agent jobs and terminals spawned later
 * never inherit the token.
 */
export function takeEnvPullSessionBridgeConfig(): PullSessionBridgeConfig | undefined {
  if (!envPullBridgeTaken) {
    envPullBridgeTaken = true;
    envPullBridge = takePullSessionBridgeConfig(process.env);
    envLaunchingHost = envPullBridge?.host;
  }
  return envPullBridge;
}

/**
 * The agent host integration that launched this process (the Claude Code
 * mod, the OpenCode 2 plugin), named by the pull-bridge config it handed over,
 * or undefined (a classic hook or skill, OpenCode 1, a person at a shell).
 * Kept in remote mode, where the bridge itself is off, and after
 * `discardEnvPullSessionBridgeConfig` (--tailscale): the integration is still
 * what started the session even when "Ask this session" is not served.
 */
export function launchingSessionHost(): SessionBridgeHost | undefined {
  takeEnvPullSessionBridgeConfig();
  return envLaunchingHost;
}

/**
 * Set to "1" by the OpenCode 2 plugin on the CLI it launches when its host can
 * register the `plannotator` tool (a `tool.transform` domain). An OpenCode
 * plugin also bridges sessions where it cannot register the tool (a host
 * without the domain, or a plugin release from before the tool), so the
 * opencode advert needs this positive capability; without it the session
 * reports no tool host and the UI offers no switch for a tool that cannot
 * exist there.
 */
export const OPENCODE_TOOL_CAPABLE_ENV = "PLANNOTATOR_OPENCODE_TOOL_CAPABLE";

/**
 * The host the `plannotator` agent tool advert describes for a server: its
 * in-process bridge's host (OpenCode 2's embedded plan review), else the host
 * that launched the process. Only those integrations register the tool, and an
 * OpenCode host only when it says it can (`opencodeToolCapable`, the plugin's
 * in-process plan server; else OPENCODE_TOOL_CAPABLE_ENV on the CLI).
 */
export function agentToolHostForServer(
  sessionBridge?: { host: SessionBridgeHost } | null,
  opencodeToolCapable?: boolean,
): SessionBridgeHost | undefined {
  const host = sessionBridge?.host ?? launchingSessionHost();
  if (host === "t3") return undefined;
  if (host === "opencode" && !(opencodeToolCapable ?? process.env[OPENCODE_TOOL_CAPABLE_ENV] === "1")) return undefined;
  return host;
}

/**
 * Take the pull-bridge config from the environment and throw it away, so no
 * later `createAIRuntime` in this process serves it. Also scrubs the env.
 * (`--tailscale` used to call it; it now keeps the bridge for this machine
 * and the owner's Tailscale login, see session-tailnet.ts.)
 */
export function discardEnvPullSessionBridgeConfig(): void {
  takeEnvPullSessionBridgeConfig();
  envPullBridge = undefined;
}

export async function createAIRuntime(options: CreateAIRuntimeOptions = {}): Promise<AIRuntime> {
  const cwd = options.cwd ?? process.cwd();
  const registry = new ProviderRegistry();
  const sessionManager = new SessionManager();
  // Model discovery spawns the provider's CLI, so it runs on first explicit
  // activation (?activate= from a model picker) or the first session — never
  // at startup.
  const discovery = createDeferredModelDiscovery();
  const deferModelDiscovery = discovery.defer;

  const registerSdkProviders = async (registry: ProviderRegistry): Promise<void> => {
    try {
      await import("@plannotator/ai/providers/claude-agent-sdk");
      const claudePath = Bun.which("claude", { PATH: childPath() });
      const provider = await createProvider({
        type: "claude-agent-sdk",
        cwd,
        ...(claudePath && { claudeExecutablePath: claudePath }),
      });
      const providerId = registry.register(provider);
      // A Claude session spawns its own `claude`, so it never waits on discovery
      // (~2s, up to 10s): the first Ask AI answer starts at once.
      deferModelDiscovery(providerId, provider, { blockSession: false });
    } catch {
      // Claude SDK not available.
    }

    try {
      await import("@plannotator/ai/providers/codex-app-server");
      const codexPath = Bun.which("codex", { PATH: childPath() });
      if (codexPath) {
        const provider = await createProvider({
          type: "codex-sdk",
          cwd,
          ...(codexPath ? { codexExecutablePath: codexPath } : {}),
        });
        const providerId = registry.register(provider);
        deferModelDiscovery(providerId, provider);
      }
    } catch {
      // Codex not available.
    }

    try {
      await import("@plannotator/ai/providers/pi-sdk");
      const rawPiPath = Bun.which("pi", { PATH: childPath() });
      if (rawPiPath) {
        const piPath = resolveWindowsCommandShim(rawPiPath);
        const provider = await createProvider({
          type: "pi-sdk",
          cwd,
          piExecutablePath: piPath,
        } as PiSDKConfig);
        const providerId = registry.register(provider);
        // Deferred like Codex: fetchModels spawns `pi` (up to 10s), and done
        // eagerly it held every plain /api/ai/capabilities answer until it
        // finished, even when a session bridge replaced the SDK providers. A
        // Pi session spawns its own `pi` and runs on Pi's default model when
        // none is picked, so it never waits on discovery either.
        deferModelDiscovery(providerId, provider, { blockSession: false });
      }
    } catch {
      // Pi not available.
    }

    try {
      await import("@plannotator/ai/providers/opencode-sdk");
      const opencodePath = Bun.which("opencode", { PATH: childPath() });
      if (opencodePath) {
        const provider = await createProvider({
          type: "opencode-sdk",
          cwd,
        });
        const providerId = registry.register(provider);
        // Deferred like Codex: fetchModels spawns `opencode serve`, so it must
        // NOT run eagerly at startup — that spawned a server on every session
        // for every user with opencode installed, and interrupted sessions
        // orphaned it. The initializer runs on first explicit activation
        // (?activate= from the model picker) or first opencode session.
        deferModelDiscovery(providerId, provider);
      }
    } catch {
      // OpenCode not available.
    }

    try {
      await import("@plannotator/ai/providers/qwen-sdk");
      const rawQwenPath = Bun.which("qwen", { PATH: childPath() });
      if (rawQwenPath) {
        const provider = await createProvider({
          type: "qwen-sdk",
          cwd,
          qwenExecutablePath: resolveWindowsCommandShim(rawQwenPath),
        } as QwenSDKConfig);
        const providerId = registry.register(provider);
        // Discovery reads Qwen Code's settings.json (no process), and a
        // session runs on qwen's own default model when none is picked.
        deferModelDiscovery(providerId, provider, { blockSession: false });
      }
    } catch {
      // Qwen Code not available.
    }
  };

  // Off in remote mode, in-process or pulled: anyone who can reach the session
  // URL could otherwise type into the agent session (same reasoning as the
  // agent terminal).
  const remote = isRemoteSession();
  const inProcessBridge = remote ? undefined : options.sessionBridge;
  const envPull = options.pullSessionBridge === undefined ? takeEnvPullSessionBridgeConfig() : undefined;
  const pullConfig = remote || inProcessBridge ? undefined : (options.pullSessionBridge ?? envPull);
  const pullBridge = pullConfig ? createPullSessionBridge(pullConfig) : null;
  const sessionBridge = inProcessBridge ?? pullBridge?.bridge;
  const bridgeProvider = sessionBridge ? new SessionBridgeProvider(sessionBridge) : null;

  // A host session is attached: Ask AI goes to that session and nowhere else.
  // The bridge is the only Ask AI provider, so /api/ai/capabilities lists only
  // it (as the default) and /api/ai/session refuses any other provider id,
  // whatever the client saved. The SDK providers still register, in a
  // catalog-only registry, so the agent-job launchers keep their discovered
  // model lists (`?activate=<id>` reports them under `catalogProviders`).
  const catalogRegistry = bridgeProvider ? new ProviderRegistry() : null;
  if (bridgeProvider) registry.register(bridgeProvider, SESSION_BRIDGE_PROVIDER_NAME);
  await registerSdkProviders(catalogRegistry ?? registry);

  // This machine only. A request that came through Tailscale never counts,
  // even in a session that was never published: a `--bg` serve mapping a
  // crashed `--tailscale` session left behind can point at a later local
  // session on the same port.
  const localHostname = options.localHostname !== undefined ? options.localHostname : getLocalUrlHostname();
  const localBridgeRequest = (req: Request) =>
    isLoopbackHostHeader(req.headers.get("host"), options.getServerPort?.(), localHostname) && !cameThroughTailscale(req.headers);
  // A tailnet-published session with a bridge: who may ask the agent session
  // is decided per request. Without one (or without a bridge) the guard is
  // exactly the local one.
  const tailnet = bridgeProvider ? options.tailnet : undefined;
  const servedPullBridge = pullBridge
    ? {
        // The host's own channel: this machine only, whatever Host is claimed.
        handle: (req: Request) =>
          (tailnet ? tailnet.audience(req) === "local" : !cameThroughTailscale(req.headers))
            ? pullBridge.handle(req)
            : Promise.resolve(Response.json({ error: "Not found" }, { status: 404 })),
      }
    : null;

  const endpoints = createAIEndpoints({
    registry,
    ...(catalogRegistry ? { catalogRegistry } : {}),
    sessionManager,
    getCwd: options.getCwd,
    beforeProviderSession: discovery.beforeProviderSession,
    authorizeSessionBridgeRequest: tailnet ? (req) => tailnet.askAllowed(req, localBridgeRequest) : localBridgeRequest,
    ...(servedPullBridge ? { pullBridge: servedPullBridge } : {}),
  });

  // Everyone else on the tailnet: the SDK providers as the Ask AI providers
  // (what `--tailscale` served before it kept the bridge), with sessions of
  // their own so no id of the owner's reaches them, and no bridge at all.
  const peerSessionManager = tailnet && catalogRegistry ? new SessionManager() : null;
  const peerEndpoints =
    tailnet && catalogRegistry && peerSessionManager
      ? createAIEndpoints({
          registry: catalogRegistry,
          sessionManager: peerSessionManager,
          getCwd: options.getCwd,
          beforeProviderSession: discovery.beforeProviderSession,
          authorizeSessionBridgeRequest: () => false,
        })
      : null;

  const served: AIEndpoints =
    tailnet && peerEndpoints
      ? (Object.fromEntries(
          (Object.keys(endpoints) as (keyof AIEndpoints)[]).map((path) => [
            path,
            (req: Request) => (tailnet.audience(req) === "peer" ? peerEndpoints[path](req) : endpoints[path](req)),
          ]),
        ) as AIEndpoints)
      : endpoints;

  return {
    endpoints: served,
    dispose: () => {
      // Detach first: tearing the sessions down must not stop a turn the
      // session is already running for us (the decision goes to that session).
      bridgeProvider?.detach();
      sessionManager.disposeAll();
      peerSessionManager?.disposeAll();
      registry.disposeAll();
      catalogRegistry?.disposeAll();
      pullBridge?.dispose();
    },
  };
}
