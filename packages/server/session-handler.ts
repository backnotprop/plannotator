export interface SessionRequestContext {
  disableIdleTimeout?: () => void;
  upgradeWebSocket?: (data: unknown) => Response | undefined;
}

export type SessionEventFamily = "external-annotations" | "agent-jobs" | "session-revision";

export type SessionEventPublisher = (
  family: SessionEventFamily,
  event: unknown,
) => void;

export type SessionSnapshotProvider = () => unknown | Promise<unknown>;

export type SessionSnapshotRegistrar = (
  family: SessionEventFamily,
  provider: SessionSnapshotProvider,
) => () => void;

export interface SessionEventBridge {
  publishEvent: SessionEventPublisher;
  registerSnapshotProvider: SessionSnapshotRegistrar;
}

export type SessionRequestHandler = (
  req: Request,
  url: URL,
  context?: SessionRequestContext,
) => Response | Promise<Response>;
