/**
 * A host that fails its sign-in check for a moment stays signed in for a while (the owner, 2026-11-23: what is open
 * never disappears). `gh auth status` checks each login's token over the network, so a Mac that just woke, or a
 * network that dropped, reads as signed out: before this, that host's PRs left the list and every open page of one
 * of them got `404 pull_unknown` until the next check, 30 s to 5 min later.
 *
 * The rule, per CLI and host:
 * - signed in now: signed in, and the time is kept;
 * - not now, but the CLI still has a login for the host (its check failed: a timeout, a token it could not check), or
 *   the CLI gave no answer it could read at all: still signed in while its last good check is under
 *   `INBOX_PULLS_SIGNED_KEEP_MS` old;
 * - the CLI answered plainly and has no login for the host (`gh auth logout`, the person signed out): gone at once.
 *
 * A kept host is checked again on the short clock (`REF_FAILURE_MS`), so it is back, or gone, soon.
 */
import type { CliHosts, RefCli, RefCommandResult } from "./ref-cards";

/** How long a host that was signed in stays so through failed checks. */
export const INBOX_PULLS_SIGNED_KEEP_MS = 10 * 60_000;

/**
 * The CLI said plainly which hosts it has a login for: gh's `--json hosts` answer (any JSON object with `hosts`), or
 * a text answer that names a login or says there is none.
 */
export function cliAnsweredPlainly(results: readonly RefCommandResult[]): boolean {
  return results.some((result) => {
    const out = result.stdout.trim();
    if (out.startsWith("{")) {
      try {
        const parsed = JSON.parse(out) as { hosts?: unknown };
        if (parsed && typeof parsed.hosts === "object" && parsed.hosts !== null) return true;
      } catch {
        // Not that JSON.
      }
    }
    return /logged in to|log in to|not logged in|no hosts logged in|not been authenticated|have been authenticated/i.test(`${result.stdout}\n${result.stderr}`);
  });
}

export function createSignedKeep(now: () => number) {
  /** `cli host` → when its last good check was. */
  const good = new Map<string, number>();
  return {
    /**
     * What the CLI's check found, with the hosts kept through a failed check added; `kept`: at least one host is only
     * kept (so it is checked again soon). `found` null: the check threw.
     */
    settle(cli: RefCli, found: CliHosts | null, plain: boolean): { set: Set<string>; kept: boolean } {
      const at = now();
      const set = new Set(found?.signedIn ?? []);
      for (const host of set) good.set(`${cli} ${host}`, at);
      let kept = false;
      const empty = !found || (found.signedIn.size === 0 && found.configured.size === 0);
      for (const [id, last] of [...good]) {
        const [owner, host] = id.split(" ") as [RefCli, string];
        if (owner !== cli || set.has(host)) continue;
        const failedCheck = !!found?.configured.has(host) || (empty && !plain);
        if (failedCheck && at - last < INBOX_PULLS_SIGNED_KEEP_MS && !found?.missing) {
          set.add(host);
          kept = true;
        } else good.delete(id);
      }
      return { set, kept };
    },
  };
}
