import {
  createAIEndpoints,
  createBestEffortOnce,
  createProvider,
  ProviderRegistry,
  SessionManager,
  type AIEndpoints,
  type PiSDKConfig,
} from "@plannotator/ai";
import { resolveWindowsCommandShim } from "@plannotator/ai/providers/command-path";

export interface AIRuntime {
  endpoints: AIEndpoints;
  dispose: () => void;
}

export const AI_QUERY_ENDPOINT = "/api/ai/query";

interface CreateAIRuntimeOptions {
  cwd?: string;
  getCwd?: () => string;
}

export async function createAIRuntime(options: CreateAIRuntimeOptions = {}): Promise<AIRuntime> {
  const cwd = options.cwd ?? process.cwd();
  const registry = new ProviderRegistry();
  const sessionManager = new SessionManager();
  const modelDiscovery: Promise<void>[] = [];
  const providerInitializers = new Map<string, () => Promise<void>>();

  try {
    await import("@plannotator/ai/providers/claude-agent-sdk");
    const claudePath = Bun.which("claude");
    const provider = await createProvider({
      type: "claude-agent-sdk",
      cwd,
      ...(claudePath && { claudeExecutablePath: claudePath }),
    });
    registry.register(provider);
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
      if ("fetchModels" in provider) {
        providerInitializers.set(
          providerId,
          createBestEffortOnce(
            () => (provider as { fetchModels: () => Promise<void> }).fetchModels(),
          ),
        );
      }
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
    const { OpenCodeProvider } = await import("@plannotator/ai/providers/opencode-sdk");
    const opencodePath = Bun.which("opencode");
    if (opencodePath) {
      const provider = await createProvider({
        type: "opencode-sdk",
        cwd,
      });
      if (provider instanceof OpenCodeProvider) {
        modelDiscovery.push(provider.fetchModels().catch(() => {}));
      }
      registry.register(provider);
    }
  } catch {
    // OpenCode not available.
  }

  const endpoints = createAIEndpoints({
    registry,
    sessionManager,
    getCwd: options.getCwd,
    beforeCapabilities: async () => {
      await Promise.allSettled(modelDiscovery);
    },
    beforeProviderSession: async (providerId) => {
      await providerInitializers.get(providerId)?.();
    },
  });

  return {
    endpoints,
    dispose: () => {
      sessionManager.disposeAll();
      registry.disposeAll();
    },
  };
}
