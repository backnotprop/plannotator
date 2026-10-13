/**
 * Put an OpenCode 1 session URL where the user can SEE it.
 *
 * `client.app.log` only reaches OpenCode's server log file, never the TUI. A
 * remote/SSH reviewer gets no auto-opened browser, so a URL that only went to
 * the log (or to the plugin's stderr) left them with nothing to open: the
 * command looked like a hang. The toast is the visible surface, and it is
 * shown in local mode too, exactly like plan review always has.
 *
 * Every OpenCode 1 surface that opens a Plannotator UI goes through here: plan
 * review and the three slash commands on the embedded runtime. (The CLI
 * runtime has its own deduplicating `toastPlannotatorUrl` in `cli-bridge.ts`,
 * because there the URL can arrive on two channels.) OpenCode 2 has no `tui`
 * domain and shows the URL as a transcript notice instead (`notifyUrl` in
 * `v2-client.ts`); on that client the toast call below is a no-op.
 */
export function announceSessionUrl(client: any, label: string, url: string): void {
  const message = `Open ${label}: ${url}`;
  try {
    void client?.app?.log?.({ level: "info", message: `[Plannotator] ${message}` });
  } catch {
    // OpenCode logging is best-effort.
  }
  // Best-effort: older hosts without /tui/show-toast just no-op.
  try {
    const result = client?.tui?.showToast?.({
      body: { title: "Plannotator", message, variant: "info" },
    });
    // A fetch-level failure (host restarting) rejects the SDK promise; swallow
    // it so a cosmetic toast can never surface an unhandled rejection.
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {
    // Toast delivery is best-effort.
  }
}
