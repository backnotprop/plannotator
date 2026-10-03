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
  type SessionBridge,
} from "@plannotator/ai";
import { resolveWindowsCommandShim } from "@plannotator/ai/providers/command-path";
import { isLoopbackHostHeader } from "@plannotator/shared/loopback-host";
import { isRemoteSession } from "./remote";

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
   * that opened Plannotator passes its bridge here. It is registered after the
   * SDK providers, so the server default is unchanged; the client prefers it.
   */
  sessionBridge?: SessionBridge;
  /**
   * The port this server listens on, once bound. Required for the bridge to
   * answer: its requests must carry a loopback Host with exactly this port
   * (DNS-rebinding guard). Undefined (not bound yet) refuses bridge requests.
   */
  getServerPort?: () => number | undefined;
  /**
   * "Ask this session" for a host that launched this server as a SEPARATE
   * process (the OpenCode plugin, the Claude Code mod): the host long-polls
   * `/api/ai/bridge/poll` with this token (session-bridge-pull.ts). Defaults to
   * the config the host put in the environment (`PLANNOTATOR_SESSION_BRIDGE_*`),
   * taken once per process and removed from `process.env`. Ignored when an
   * in-process `sessionBridge` is given, and off in remote mode.
   */
  pullSessionBridge?: PullSessionBridgeConfig | null;
}

let envPullBridgeTaken = false;
let envPullBridge: PullSessionBridgeConfig | undefined;

/**
 * The pull-bridge config from the environment, read once per process. Taking
 * it also deletes the variables, so agent jobs and terminals spawned later
 * never inherit the token.
 */
export function takeEnvPullSessionBridgeConfig(): PullSessionBridgeConfig | undefined {
  if (!envPullBridgeTaken) {
    envPullBridgeTaken = true;
    envPullBridge = takePullSessionBridgeConfig(process.env);
  }
  return envPullBridge;
}

/**
 * Take the pull-bridge config from the environment and throw it away, so no
 * later `createAIRuntime` in this process serves it (a `--tailscale` session
 * is reachable from other devices, like remote mode). Also scrubs the env.
 */
export function discardEnvPullSessionBridgeConfig(): void {
  takeEnvPullSessionBridgeConfig();
  envPullBridge = undefined;
}

export async function createAIRuntime(options: CreateAIRuntimeOptions = {}): Promise<AIRuntime> {
  const cwd = options.cwd ?? process.cwd();
  const registry = new ProviderRegistry();
  const sessionManager = new SessionManager();
  const modelDiscovery: Promise<void>[] = [];
  // Model discovery spawns the provider's CLI, so it runs on first explicit
  // activation (?activate= from a model picker) or the first session — never
  // at startup.
  const discovery = createDeferredModelDiscovery();
  const deferModelDiscovery = discovery.defer;

  try {
    await import("@plannotator/ai/providers/claude-agent-sdk");
    const claudePath = Bun.which("claude");
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
    const codexPath = Bun.which("codex");
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
    const { PiSDKProvider } = await import("@plannotator/ai/providers/pi-sdk");
    const rawPiPath = Bun.which("pi");
    if (rawPiPath) {
      const piPath = resolveWindowsCommandShim(rawPiPath);
      const provider = await createProvider({
        type: "pi-sdk",
        cwd,
        piExecutablePath: piPath,
      } as PiSDKConfig);
      if (provider instanceof PiSDKProvider) {
        modelDiscovery.push(provider.fetchModels().catch(() => {}));
      }
      registry.register(provider);
    }
  } catch {
    // Pi not available.
  }

  try {
    await import("@plannotator/ai/providers/opencode-sdk");
    const opencodePath = Bun.which("opencode");
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
    await import("@plannotator/ai/providers/antigravity-ls");
    const rawAgyPath = process.env.ANTIGRAVITY_AGENTAPI_EXE || Bun.which("agy");
    if (rawAgyPath || process.env.ANTIGRAVITY_LS_ADDRESS) {
      const agyPath = rawAgyPath ? resolveWindowsCommandShim(rawAgyPath) : undefined;
      const provider = await createProvider({
        type: "antigravity-ls",
        cwd,
        ...(agyPath ? { executablePath: agyPath } : {}),
      });
      const providerId = registry.register(provider);
      deferModelDiscovery(providerId, provider, { blockSession: false });
    }
  } catch {
    // Antigravity not available.
  }

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
  if (bridgeProvider) registry.register(bridgeProvider, SESSION_BRIDGE_PROVIDER_NAME);

  const endpoints = createAIEndpoints({
    registry,
    sessionManager,
    getCwd: options.getCwd,
    beforeCapabilities: async () => {
      await Promise.allSettled(modelDiscovery);
    },
    beforeProviderSession: discovery.beforeProviderSession,
    authorizeSessionBridgeRequest: (req) =>
      isLoopbackHostHeader(req.headers.get("host"), options.getServerPort?.()),
    ...(pullBridge ? { pullBridge } : {}),
  });

  return {
    endpoints,
    dispose: () => {
      // Detach first: tearing the sessions down must not stop a turn the
      // session is already running for us (the decision goes to that session).
      bridgeProvider?.detach();
      sessionManager.disposeAll();
      registry.disposeAll();
      pullBridge?.dispose();
    },
  };
}
