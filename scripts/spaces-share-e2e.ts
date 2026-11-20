/**
 * Share this space against a REAL Spaces server: one share, one Update, then (with a token) the claim's effect and
 * the approval. Skipped by default: it does nothing unless SPACES_E2E_URL names the server. Nothing in CI or in the
 * test suite runs it; the unit tests use a stand-in (tests/helpers/fake-spaces.ts), which proves this side of the
 * contract only.
 *
 * What it needs:
 * - SPACES_E2E_URL: the origin of a TEST copy of Spaces (none existed when this was written). `https`, or `http` on
 *   this computer. Never the real service: it creates spaces it cannot delete without a token.
 * - SPACES_E2E_TOKEN (optional): a `wscli_live_…` token of a test account, to run the signed-in half (a private
 *   space, the approval, the delete at the end). Without it only the no-account half runs.
 *
 * - SPACES_E2E_MODE (optional): `all` (default) or `newest`.
 * - SPACES_E2E_BURST (optional): a number of small writes (the same file again, which changes nothing) made after
 *   the first share, to use up the per-minute allowance so the update that follows has to wait; its line then
 *   shows the 429 and the wait.
 *
 * usage: SPACES_E2E_URL=http://127.0.0.1:8787 bun scripts/spaces-share-e2e.ts
 *
 * It works in a scratch data dir of its own and prints each step's result as a line of JSON; exit 1 on a surprise.
 * What to read in its output, since each is unconfirmed against a real server: the create's answer shape
 * (`share_url`, the first page's id and version), the media type a Mermaid page's raw save takes, whether a replayed
 * comment (same Idempotency-Key) makes one comment, and the code of the approval call.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSpaceId, newSpaceShareRecord, type SpaceShareRecord } from "../packages/core/space-share";
import { createSpacesClient } from "../packages/shared/spaces/client";
import { runSpaceShare } from "../packages/shared/spaces/engine";
import { spaceShareSource } from "../packages/shared/spaces/share-job";
import { normalizeSpacesUrl } from "../packages/shared/spaces/url";
import { seedSpaceShareWorld } from "../tests/helpers/space-share-world";

const raw = process.env.SPACES_E2E_URL;
if (!raw) {
  console.log("spaces-share-e2e: skipped (set SPACES_E2E_URL to a test copy of Spaces to run it).");
  process.exit(0);
}
const host = normalizeSpacesUrl(raw);
if (!host) {
  console.error("spaces-share-e2e: SPACES_E2E_URL must be https, or http on this computer.");
  process.exit(1);
}
const token = process.env.SPACES_E2E_TOKEN || null;
const say = (step: string, value: unknown) => console.log(JSON.stringify({ step, ...((value as object) ?? {}) }));
const mode = process.env.SPACES_E2E_MODE === "newest" ? "newest" : "all";
// Every call, as the server answered it (ids left out of the path).
const calls: string[] = [];
const logged: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  const path = new URL(String(input)).pathname.replace(/(ws|doc|anno|asset|reply)_[0-9A-Za-z]+/g, "$1");
  calls.push(`${init?.method ?? "GET"} ${path} ${response.status}${response.headers.get("retry-after") ? ` retry-after=${response.headers.get("retry-after")}` : ""}`);
  return response;
};

async function share(label: string, record: SpaceShareRecord, dataDir: string, plan: string, store: ReturnType<typeof seedSpaceShareWorld>["store"]) {
  const result = await runSpaceShare({
    source: spaceShareSource(store, plan)!,
    record,
    save: () => {},
    client: createSpacesClient({ host: host!, token, fetch: logged }),
    progress: (p) => p.waiting_until !== null && say(`${label}: waiting`, { done: p.done, total: p.total, seconds: Math.ceil((p.waiting_until - Date.now()) / 1000) }),
  });
  say(`${label}: calls`, { calls: calls.splice(0) });
  say(label, { end: result.end, error: result.error ? { status: result.error.status, code: result.error.code } : null, link: record.share_url, pages: Object.values(record.pages).map((p) => ({ path: p.doc_path, lane: p.lane, pushed: p.pushed.length, stopped: p.stopped })), files: Object.keys(record.files).length, comments: record.comments, approval: record.approval, approval_refused: record.approval_refused });
  return result.end;
}

const dataDir = mkdtempSync(join(tmpdir(), "spaces-share-e2e-"));
const world = seedSpaceShareWorld(dataDir);
const record = newSpaceShareRecord({ host, space_id: newSpaceId(), name: "Plannotator share check", mode, kept: token !== null, at: new Date().toISOString() });
let ok = (await share("first share", record, dataDir, world.plan, world.store)) === "done";
const burst = Number(process.env.SPACES_E2E_BURST ?? 0);
if (ok && burst > 0) {
  const { TINY_PNG } = await import("../tests/helpers/space-share-world");
  const client = createSpacesClient({ host, token, fetch: logged });
  let made = 0;
  try {
    for (; made < burst; made++) await client.putFile(record.space_id, "architecture.png", TINY_PNG, "image/png");
  } catch {
    // The allowance ran out: what the update below must wait for.
  }
  say("burst", { made, last: calls[calls.length - 1] });
  calls.splice(0);
}
world.store.addVersion(world.plan, world.main, { bytes: new TextEncoder().encode("# Rate limiting for public endpoints\n\nA fifth version.\n"), committed_at: new Date().toISOString(), source: "plan-review" });
ok = (await share("update", record, dataDir, world.plan, world.store)) === "done" && ok;
ok = (await share("nothing new", record, dataDir, world.plan, world.store)) === "done" && ok;
if (token && record.created) {
  try {
    await createSpacesClient({ host, token }).deleteSpace(record.space_id);
    say("delete", { deleted: true });
  } catch (error) {
    say("delete", { deleted: false, error: String(error) });
    ok = false;
  }
} else if (record.created) {
  say("left behind", { space: record.space_id, note: "a space nobody kept cannot be deleted; it goes after 30 idle days" });
}
process.exit(ok ? 0 : 1);
