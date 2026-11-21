/**
 * A Forgejo / Gitea pull request on a thread of a LINKED machine, on two real Inboxes linked both ways (the same
 * harness as inbox-machine-pulls-linked.test.ts). Only B can read the Forgejo (it has the reader, as a machine with the
 * host named and a token would); A has none, as a machine with no Forgejo setup. The rule being kept: the person's
 * window on A shows B's thread's PRs exactly as B reads them, and a PR added from A's window is read on B, because the
 * action goes to the machine that owns the thread ("One experience across a person's devices", CLAUDE.md).
 *
 * What regresses: A reading B's Forgejo PRs itself (it would answer "host not named", the state never arriving); a
 * PR added from A's window not landing on B's thread; B's reader never asked.
 *
 * Starts Inboxes: CI runs it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ForgeRefCardData } from "@plannotator/core/forge-ref-card";
import { parseInboxThreadPullRef } from "@plannotator/core/inbox-types";
import type { RefRunner } from "@plannotator/shared/ref-cards";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { startInboxServer, type InboxServer } from "./inbox";
import { waitFor } from "../../tests/helpers/inbox-world";

type Json = Record<string, any>;

const tailscale: TailscaleRunner = (args) => ({ status: 0, stdout: args[1] === "status" ? "{}" : "", stderr: "" });
/** No CLI exists on either machine: a Forgejo is read with its token, so nothing here may run gh or glab. */
const noCli: RefRunner = async () => ({ stdout: "", stderr: "not found", exitCode: 127 });

describe("a Forgejo PR on a linked machine's thread", () => {
  const dirs: string[] = [];
  const sandboxWas = process.env.PLANNOTATOR_TEST_SANDBOX;
  beforeAll(() => {
    process.env.PLANNOTATOR_TEST_SANDBOX = "1";
  });
  afterAll(() => {
    if (sandboxWas === undefined) delete process.env.PLANNOTATOR_TEST_SANDBOX;
    else process.env.PLANNOTATOR_TEST_SANDBOX = sandboxWas;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const scratch = (prefix: string) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
  };
  const at = (port: number) => `http://127.0.0.1:${port}`;
  const session = async (port: number) => ((await (await fetch(`${at(port)}/api/inbox/health`)).json()) as Json).serverSession as string;
  let keys = 0;
  const press = async (port: number, path: string, body: Json) =>
    fetch(`${at(port)}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: at(port) },
      body: JSON.stringify({ serverSession: await session(port), idempotency_key: `window-forgejo-${++keys}`, ...body }),
    });

  /** codeberg.org is a Forgejo with nothing configured: pull 5 is merged with failing checks, 6 is open. */
  const forgejoReader = (asked: string[]) => async (ref: { host: string; owner: string; repo: string; number: number }) => {
    asked.push(`${ref.host}/${ref.owner}/${ref.repo}#${ref.number}`);
    const merged = ref.number === 5;
    return {
      platform: "forgejo", kind: "pull", repo: `${ref.owner}/${ref.repo}`, number: ref.number, url: `https://${ref.host}/${ref.owner}/${ref.repo}/pulls/${ref.number}`,
      title: merged ? "Merged on B" : "Open on B", state: merged ? "merged" : "open", author: null, createdAt: "", updatedAt: "", closedAt: null, labels: [], assignees: [],
      comments: 0, body: "", bodyCut: false, lastComment: null, linked: [],
      pull: { base: "main", head: "feature", additions: 1, deletions: 0, files: 1, review: null, checks: { state: "failure", passed: 0, failed: 1, pending: 0, total: 1 } },
    } as unknown as ForgeRefCardData;
  };

  test("A's window reads B's thread's Forgejo PR as B reads it, and a PR added from A lands on B and is read there", async () => {
    const askedA: string[] = [];
    const askedB: string[] = [];
    const dataA = scratch("plannotator-forgejo-linked-a-");
    const dataB = scratch("plannotator-forgejo-linked-b-");
    // A has NO Forgejo reader (and no CLI); B has one.
    const a: InboxServer = await startInboxServer({ dataDir: dataA, binaryPath: null, phones: false, tailscale, codeReview: true, refRunner: noCli, readProjectRepo: async () => null });
    const b: InboxServer = await startInboxServer({ dataDir: dataB, binaryPath: null, phones: false, tailscale, codeReview: true, refRunner: noCli, forgejoRefReader: forgejoReader(askedB), readProjectRepo: async () => null });
    try {
      const offered = (await (await fetch(`${at(b.port)}/api/inbox/machines/offer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as Json;
      const linked = await fetch(`${at(a.port)}/api/inbox/machines/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ link: offered.link, address: at(b.port), back: at(a.port) }) });
      expect(linked.status).toBe(201);
      const bId = ((JSON.parse(readFileSync(join(dataA, "inbox", "machines.json"), "utf8")) as Json).links[0] as Json).id as string;

      // A thread on B, its agent's message and one Forgejo PR on it.
      const project = b.store.ensureProject({ name: "widgets", root: scratch("plannotator-forgejo-linked-project-") });
      const sent = b.store.sendMessage({ project_id: project.id, author: { kind: "agent", host: "claude-code", session: "ses_b", name: "Claude Code" }, body: "Opened the Forgejo change", subject: "Forgejo change" });
      const thread = sent.message.thread_id;
      const first = parseInboxThreadPullRef("https://codeberg.org/acme/widgets/pulls/5") as Exclude<ReturnType<typeof parseInboxThreadPullRef>, { error: string }>;
      b.store.changeThreadPulls({ thread_id: thread, add: [first], by: { kind: "agent", host: "claude-code", session: "ses_b", name: "Claude Code" } });
      await waitFor("B's thread on A", async () => {
        const list = (await (await fetch(`${at(a.port)}/api/inbox/threads?machines=1`)).json()) as Json;
        return (list.sections as Json[]).some((s) => (s.threads as Json[]).some((row) => row.thread_id === thread));
      });

      // A's window reads it through the forward: B's reader answers, so the state and checks arrive (the read runs behind the first answer).
      const read = async () => (await (await fetch(`${at(a.port)}/api/inbox/m/${bId}/threads/${thread}/pulls`)).json()) as Json;
      const merged = await waitFor("B's read of the Forgejo PR on A's window", async () => {
        const pull = ((await read()).pulls as Json[]).find((p) => p.platform === "forgejo" && p.state === "merged");
        return pull ?? null;
      });
      expect(merged).toMatchObject({ platform: "forgejo", label: "#5", title: "Merged on B", checks: "failing" });
      expect(merged.problem).toBeUndefined();

      // A PR added from A's window goes to B's thread, and B reads it.
      const added = await press(a.port, `/api/inbox/m/${bId}/threads/${thread}/pulls`, { add: ["https://codeberg.org/acme/widgets/pulls/6"] });
      expect(added.status).toBe(200);
      expect(b.store.threadPulls(thread).map((p) => p.pull)).toEqual(["codeberg.org/acme/widgets#5", "codeberg.org/acme/widgets#6"]);
      expect(a.store.message(thread)).toBeNull();
      await waitFor("B's read of the added PR", async () => ((await read()).pulls as Json[]).find((p) => p.label === "#6" && p.state === "open") ?? null);

      // Every read ran on B; A, with no reader, never asked anything.
      expect(askedB).toContain("codeberg.org/acme/widgets#5");
      expect(askedB).toContain("codeberg.org/acme/widgets#6");
      expect(askedA).toEqual([]);
    } finally {
      a.stop();
      b.stop();
    }
  }, 60_000);
});
