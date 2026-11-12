export const BROWSER_SESSION_STOPPED = "PlannotatorBrowserSessionStopped";

export function isBrowserSessionStoppedError(err: unknown): boolean {
	return err instanceof Error && err.name === BROWSER_SESSION_STOPPED;
}
