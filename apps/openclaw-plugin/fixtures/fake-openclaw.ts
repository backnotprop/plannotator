import type {
  OpenClawAgentEventSubscription,
  OpenClawDeliveryContext,
  OpenClawPluginApi,
  OpenClawService,
  OpenClawSessionEventOptions,
  OpenClawSessionEventReceipt,
  OpenClawTool,
  OpenClawToolContext,
  OpenClawToolFactory,
} from "../openclaw";

export interface FakeTurn {
  agentId: string;
  sessionKey: string;
  text: string;
  route: OpenClawDeliveryContext | undefined;
}

export class FakeOpenClaw implements OpenClawPluginApi {
  readonly id = "plannotator";
  readonly said: string[] = [];
  readonly logger = { warn: (message: string) => void this.said.push(message), info: (message: string) => void this.said.push(message) };
  readonly factories: { factory: OpenClawToolFactory; name?: string }[] = [];
  readonly services: OpenClawService[] = [];
  readonly subscriptions: OpenClawAgentEventSubscription[] = [];
  readonly turns: FakeTurn[] = [];
  readonly sessions = new Set<string>();
  private readonly targets = new WeakMap<object, { agentId: string; sessionKey: string }>();
  private runCount = 0;

  readonly agent = { events: { registerAgentEventSubscription: (subscription: OpenClawAgentEventSubscription) => void this.subscriptions.push(subscription) } };

  readonly runtime = {
    system: {
      captureSessionEventTarget: async (agentId: string, sessionKey: string): Promise<unknown> => {
        if (!this.sessions.has(`${agentId}/${sessionKey}`)) throw new Error("Session event origin is missing; start fresh authorized work instead");
        const handle = Object.freeze({});
        this.targets.set(handle, { agentId, sessionKey });
        return handle;
      },
      enqueueSessionEvent: (text: string, options: OpenClawSessionEventOptions): OpenClawSessionEventReceipt => {
        const target = options.expectedTarget ? this.targets.get(options.expectedTarget as object) : undefined;
        if (!target || target.agentId !== options.agentId || target.sessionKey !== options.sessionKey) {
          throw new Error("Session event target was not captured by this runtime; capture it before asynchronous work");
        }
        if (!text.trim()) throw new Error("Session event text must not be empty");
        this.turns.push({ agentId: options.agentId, sessionKey: options.sessionKey, text, route: options.deliveryContext });
        return { id: `event-${this.turns.length}`, cancel: () => false, accepted: Promise.resolve({ ok: true }), settled: Promise.resolve({ status: "completed" }) };
      },
    },
  };

  registerTool(factory: OpenClawToolFactory, opts?: { name?: string }): void {
    this.factories.push({ factory, ...(opts?.name ? { name: opts.name } : {}) });
  }

  registerService(service: OpenClawService): void {
    this.services.push(service);
  }

  async startServices(): Promise<void> {
    for (const service of this.services) await service.start({});
  }

  async stopServices(): Promise<void> {
    for (const service of this.services) await service.stop?.({});
  }

  openSession(agentId: string, sessionKey: string): void {
    this.sessions.add(`${agentId}/${sessionKey}`);
  }

  toolsFor(ctx: OpenClawToolContext): OpenClawTool[] {
    if (ctx.agentId && ctx.sessionKey) this.openSession(ctx.agentId, ctx.sessionKey);
    return this.factories.map(({ factory, name }) => {
      const tool = factory(ctx);
      if (tool && name && tool.name !== name) throw new Error(`plugin tool is undeclared: ${tool.name}`);
      return tool;
    }).filter((tool): tool is OpenClawTool => !!tool);
  }

  run(sessionKey: string, running: boolean, runId = `run-${++this.runCount}`): string {
    for (const subscription of this.subscriptions) {
      void subscription.handle({ runId, stream: "lifecycle", sessionKey, agentId: "main", data: { phase: running ? "start" : "end" } });
    }
    return runId;
  }
}
