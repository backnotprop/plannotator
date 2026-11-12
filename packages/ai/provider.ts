import type { AIProvider, AIProviderConfig } from "./types.ts";

type ProviderFactory = (config: AIProviderConfig) => Promise<AIProvider>;
const factories = new Map<string, ProviderFactory>();

export function registerProviderFactory(
  type: string,
  factory: ProviderFactory
): void {
  factories.set(type, factory);
}

export async function createProvider(
  config: AIProviderConfig
): Promise<AIProvider> {
  const factory = factories.get(config.type);
  if (!factory) {
    throw new Error(
      `No AI provider factory registered for type "${config.type}". ` +
        `Available: ${[...factories.keys()].join(", ") || "(none)"}`
    );
  }
  return factory(config);
}

export class ProviderRegistry {
  private instances = new Map<string, AIProvider>();

  register(provider: AIProvider, instanceId?: string): string {
    const id = instanceId ?? provider.name;
    this.instances.set(id, provider);
    return id;
  }

  get(instanceId: string): AIProvider | undefined {
    return this.instances.get(instanceId);
  }

  getDefault(): { id: string; provider: AIProvider } | undefined {
    const first = this.instances.entries().next();
    if (first.done) return undefined;
    return { id: first.value[0], provider: first.value[1] };
  }

  getByType(typeName: string): AIProvider[] {
    return [...this.instances.values()].filter((p) => p.name === typeName);
  }

  list(): string[] {
    return [...this.instances.keys()];
  }

  dispose(instanceId: string): void {
    const provider = this.instances.get(instanceId);
    if (provider) {
      provider.dispose();
      this.instances.delete(instanceId);
    }
  }

  disposeAll(): void {
    for (const provider of this.instances.values()) {
      provider.dispose();
    }
    this.instances.clear();
  }

  get size(): number {
    return this.instances.size;
  }
}
