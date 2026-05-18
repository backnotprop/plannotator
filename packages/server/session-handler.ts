export interface SessionRequestContext {
  disableIdleTimeout?: () => void;
}

export type SessionRequestHandler = (
  req: Request,
  url: URL,
  context?: SessionRequestContext,
) => Response | Promise<Response>;
