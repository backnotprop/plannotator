import {
  createAIEndpoints,
  createDeferredModelDiscovery,
  createProvider,
  ProviderRegistry,
  SESSION_BRIDGE_PROVIDER_NAME,
  SessionBridgeProvider,
  SessionManager,
  type AIEndpoints,
  type PiSDKConfig,
  type SessionBridge,
} from "@plannotator/ai";
import { resolveWindowsCommandShim } from "@plannotator/ai/providers/command-path";
import { isLoopbackHostHeader } from "@plannotator/shared/loopback-host";

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

  const bridgeProvider = options.sessionBridge ? new SessionBridgeProvider(options.sessionBridge) : null;
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
  });

  return {
    endpoints,
    dispose: () => {
      // Detach first: tearing the sessions down must not stop a turn the
      // session is already running for us (the decision goes to that session).
      bridgeProvider?.detach();
      sessionManager.disposeAll();
      registry.disposeAll();
    },
  };
}
