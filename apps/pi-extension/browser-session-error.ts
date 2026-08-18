/**
 * Typed marker for the "browser session was stopped" outcome.
 *
 * Kept in a zero-import module so index.ts can classify the error
 * synchronously without pulling in plannotator-browser.ts's heavy
 * server/browser import graph.
 */
export const BROWSER_SESSION_STOPPED = "PlannotatorBrowserSessionStopped";

/** True when an error is the typed stopped-session outcome, not a real failure. */
export function isBrowserSessionStoppedError(err: unknown): boolean {
	return err instanceof Error && err.name === BROWSER_SESSION_STOPPED;
}
