export interface ServiceConfig {
  name: string;
  version: string;
  timeout: number;
  retries: number;
  enabled: boolean;
}

export interface ServiceHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latency: number;
  lastCheck: Date;
  details?: string;
}

export interface Service {
  config: ServiceConfig;
  health: ServiceHealth;
  start(): Promise<void>;
  stop(): Promise<void>;
  healthCheck(): Promise<ServiceHealth>;
}

type ServiceFactory = (config: ServiceConfig) => Service;

const DEFAULT_CONFIGS: Record<string, Partial<ServiceConfig>> = {
  database: { timeout: 5000, retries: 3 },
  cache: { timeout: 2000, retries: 1 },
  queue: { timeout: 10000, retries: 5 },
  search: { timeout: 3000, retries: 2 },
  email: { timeout: 15000, retries: 3 },
  storage: { timeout: 8000, retries: 2 },
};

export class ServiceRegistry {
  private services: Map<string, Service> = new Map();
  private factories: Map<string, ServiceFactory> = new Map();
  private startOrder: string[] = [];
  private isShuttingDown = false;

  registerFactory(name: string, factory: ServiceFactory): void {
    if (this.factories.has(name)) {
      throw new Error(`Factory already registered for service: ${name}`);
    }
    this.factories.set(name, factory);
  }

  async getService(name: string): Promise<Service> {
    const existing = this.services.get(name);
    if (existing) return existing;

    const factory = this.factories.get(name);
    if (!factory) {
      throw new Error(`No factory registered for service: ${name}`);
    }

    const defaults = DEFAULT_CONFIGS[name] || {};
    const config: ServiceConfig = {
      name,
      version: '1.0.0',
      timeout: defaults.timeout ?? 5000,
      retries: defaults.retries ?? 3,
      enabled: true,
      ...defaults,
    };

    const service = factory(config);
    this.services.set(name, service);
    return service;
  }

  async startAll(): Promise<void> {
    console.log(`Starting ${this.services.size} services...`);

    for (const [name, service] of this.services) {
      if (!service.config.enabled) {
        console.log(`Skipping disabled service: ${name}`);
        continue;
      }

      try {
        await service.start();
        this.startOrder.push(name);
        console.log(`Started: ${name} (v${service.config.version})`);
      } catch (err) {
        console.error(`Failed to start ${name}:`, err);
        throw err;
      }
    }
  }

  async stopAll(): Promise<void> {
    if (this.isShuttingDown) return;
    this.isShuttingDown = true;

    console.log('Shutting down services...');
    const reversed = [...this.startOrder].reverse();

    for (const name of reversed) {
      const service = this.services.get(name);
      if (!service) continue;

      try {
        await service.stop();
        console.log(`Stopped: ${name}`);
      } catch (err) {
        console.error(`Error stopping ${name}:`, err);
      }
    }

    this.services.clear();
    this.startOrder = [];
    this.isShuttingDown = false;
  }

  async healthCheckAll(): Promise<Map<string, ServiceHealth>> {
    const results = new Map<string, ServiceHealth>();

    for (const [name, service] of this.services) {
      try {
        const health = await service.healthCheck();
        results.set(name, health);
      } catch (err) {
        results.set(name, {
          status: 'unhealthy',
          latency: -1,
          lastCheck: new Date(),
          details: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    return results;
  }

  listServices(): Array<{ name: string; running: boolean; health?: ServiceHealth }> {
    return Array.from(this.factories.keys()).map(name => {
      const service = this.services.get(name);
      return {
        name,
        running: !!service,
        health: service?.health,
      };
    });
  }

  get runningCount(): number {
    return this.services.size;
  }

  isRunning(name: string): boolean {
    return this.services.has(name);
  }
}
