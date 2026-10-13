/**
 * Path-keyed annotate drafts (packages/shared/annotate-draft.ts), driven over
 * HTTP against a real annotate server. Shared by the Bun suite
 * (annotate-draft.test.ts) and the Pi mirror
 * (apps/pi-extension/server/serverAnnotate-drafts.test.ts), so both runtimes
 * answer the same scenarios.
 *
 * Every test runs under a temp PLANNOTATOR_DATA_DIR; nothing touches the
 * real ~/.plannotator.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface DraftScenarioServer {
  url: string;
  stop: () => void;
}

export type StartDraftScenarioServer = (options: {
  markdown: string;
  filePath: string;
  mode?: "annotate" | "annotate-folder";
  folderPath?: string;
  /** Bearer token for /api/host/* (#1709); absent leaves host control off. */
  hostControlToken?: string;
}) => Promise<DraftScenarioServer>;

const HOST_TOKEN = "annotate-draft-scenarios-host-token-0123456789abcdef";

const ENV_KEYS = [
  "PLANNOTATOR_DATA_DIR",
  "PLANNOTATOR_PORT",
  "PLANNOTATOR_REMOTE",
  "PLANNOTATOR_AI",
  "PLANNOTATOR_ANNOTATE_HISTORY",
] as const;

const comment = (id: string, text = id) => ({
  id,
  blockId: "",
  startOffset: 0,
  endOffset: 4,
  type: "COMMENT",
  text,
  originalText: "Body",
  createdA: 1,
});

const draftBody = (generation: number, ids: string[]) => ({
  annotations: ids.map((id) => comment(id)),
  globalAttachments: [],
  draftGeneration: generation,
  ts: Date.now(),
});

const idsOf = (body: { annotations?: { id: string }[] }) => (body.annotations ?? []).map((a) => a.id);

export function defineAnnotateDraftScenarios(runtime: string, start: StartDraftScenarioServer): void {
  describe(`${runtime} annotate drafts follow the file`, () => {
    const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
    let root = "";
    let docDir = "";
    const servers: DraftScenarioServer[] = [];

    beforeEach(() => {
      for (const key of ENV_KEYS) saved[key] = process.env[key];
      root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-annotate-draft-")));
      process.env.PLANNOTATOR_DATA_DIR = join(root, "data");
      delete process.env.PLANNOTATOR_PORT;
      process.env.PLANNOTATOR_REMOTE = "0";
      process.env.PLANNOTATOR_AI = "disabled";
      process.env.PLANNOTATOR_ANNOTATE_HISTORY = "0";
      docDir = join(root, "docs");
      mkdirSync(docDir, { recursive: true });
    });

    afterEach(() => {
      for (const server of servers.splice(0)) server.stop();
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key]!;
      }
      rmSync(root, { recursive: true, force: true });
    });

    /** Write the file with this text and open it alone. */
    async function openFile(name: string, text: string, hostControlToken?: string): Promise<DraftScenarioServer> {
      const filePath = join(docDir, name);
      writeFileSync(filePath, text);
      const server = await start({ markdown: text, filePath, ...(hostControlToken ? { hostControlToken } : {}) });
      servers.push(server);
      return server;
    }

    async function openFolder(): Promise<DraftScenarioServer> {
      const server = await start({ markdown: "", filePath: docDir, mode: "annotate-folder", folderPath: docDir });
      servers.push(server);
      return server;
    }

    function close(server: DraftScenarioServer): void {
      server.stop();
      servers.splice(servers.indexOf(server), 1);
    }

    const post = (server: DraftScenarioServer, path: string, body: unknown) =>
      fetch(`${server.url}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const saveDocuments = (server: DraftScenarioServer, documents: { path: string; annotations: unknown[] }[]) =>
      post(server, "/api/draft/document", { documents });

    test("a comment comes back after the file is edited and the review reopened", async () => {
      const first = await openFile("notes.md", "# Notes\n\nBody v1\n");
      expect((await post(first, "/api/draft", draftBody(1, ["c1"]))).ok).toBe(true);
      close(first);

      const reopened = await openFile("notes.md", "# Notes\n\nBody v2, edited by the agent\n");
      const res = await fetch(`${reopened.url}/api/draft`);
      expect(res.status).toBe(200);
      const draft = await res.json();
      expect(idsOf(draft)).toEqual(["c1"]);
      // Server bookkeeping never reaches the client.
      expect(draft).not.toHaveProperty("patchKey");
      expect(draft).not.toHaveProperty("patchKeys");
      expect(draft).not.toHaveProperty("patchChanged");
    });

    test("the content copy wins unless the path copy is strictly newer", async () => {
      const onA = await openFile("plan.md", "# Plan\n\nText A\n");
      await post(onA, "/api/draft", draftBody(3, ["a"]));
      close(onA);
      const onB = await openFile("plan.md", "# Plan\n\nText B\n");
      await post(onB, "/api/draft", draftBody(5, ["b"]));
      close(onB);

      // Back to text A: its own copy (generation 3) is older than the path
      // copy written on B (generation 5), so the newer comments win.
      const backOnA = await openFile("plan.md", "# Plan\n\nText A\n");
      expect(idsOf(await (await fetch(`${backOnA.url}/api/draft`)).json())).toEqual(["b"]);
      await post(backOnA, "/api/draft", draftBody(6, ["a2"]));
      close(backOnA);

      // Text B's own copy is now the older one.
      const backOnB = await openFile("plan.md", "# Plan\n\nText B\n");
      expect(idsOf(await (await fetch(`${backOnB.url}/api/draft`)).json())).toEqual(["a2"]);
    });

    test("a decision clears the draft under both keys and its tombstone guards both", async () => {
      const first = await openFile("spec.md", "# Spec\n\nv1\n");
      await post(first, "/api/draft", draftBody(1, ["c1"]));
      expect((await post(first, "/api/feedback", { feedback: "fix it", annotations: [comment("c1")], draftGeneration: 2 })).ok).toBe(true);
      close(first);

      // Neither the edited file nor the unchanged one gets the submitted comments back.
      const edited = await openFile("spec.md", "# Spec\n\nv2\n");
      const missing = await fetch(`${edited.url}/api/draft`);
      expect(missing.status).toBe(404);
      expect((await missing.json()).draftGeneration).toBeGreaterThanOrEqual(2);
      // A stale tab's save at or below the decision's generation is refused
      // and reported; a newer one lands.
      const stale = await post(edited, "/api/draft", draftBody(2, ["ghost"]));
      expect(stale.status).toBe(409);
      // The refusal names the generation to save above (the client adopts it).
      const refusal = await stale.json();
      expect(refusal.ok).toBe(false);
      expect(refusal.draftGeneration).toBeGreaterThanOrEqual(2);
      expect((await fetch(`${edited.url}/api/draft`)).status).toBe(404);
      expect((await post(edited, "/api/draft", draftBody(3, ["fresh"]))).ok).toBe(true);
      close(edited);

      const unchanged = await openFile("spec.md", "# Spec\n\nv1\n");
      expect(idsOf(await (await fetch(`${unchanged.url}/api/draft`)).json())).toEqual(["fresh"]);
    });

    test("after the decision a save is refused as decided, even above the tombstone", async () => {
      const session = await openFile("decided.md", "# Decided\n\nv1\n");
      await post(session, "/api/draft", draftBody(5, ["sent"]));
      expect((await post(session, "/api/feedback", { feedback: "x", annotations: [comment("sent")], draftGeneration: 6 })).ok).toBe(true);

      // A second tab of the same review saves at a generation the tombstone
      // would let through.
      const late = await post(session, "/api/draft", draftBody(7, ["sent"]));
      expect(late.status).toBe(409);
      expect((await late.json()).decided).toBe(true);
      close(session);

      // The sent comments do not come back, on the same text or an edited one.
      const same = await openFile("decided.md", "# Decided\n\nv1\n");
      expect((await fetch(`${same.url}/api/draft`)).status).toBe(404);
      close(same);
      const edited = await openFile("decided.md", "# Decided\n\nv2\n");
      expect((await fetch(`${edited.url}/api/draft`)).status).toBe(404);
    });

    test("an agent close keeps the draft, its path copy and document copies, and a late save completes it", async () => {
      const linked = join(docDir, "linked.md");
      writeFileSync(linked, "# Linked\n");
      const session = await openFile("kept.md", "# Kept\n\nv1\n", HOST_TOKEN);
      await post(session, "/api/draft", draftBody(3, ["kept"]));
      await saveDocuments(session, [{ path: linked, annotations: [comment("kept-linked")] }]);

      const closed = await fetch(`${session.url}/api/host/close`, {
        method: "POST",
        headers: { Authorization: `Bearer ${HOST_TOKEN}` },
      });
      expect(closed.status).toBe(200);
      // The session draft and the linked document's copy both count.
      expect(await closed.json()).toEqual({ unsentAnnotations: 2 });

      // The tab's debounced save for a comment typed just before the close
      // arrives after it, and lands: an agent close deletes nothing, so the
      // kept draft must be complete. Same for a document copy.
      expect((await post(session, "/api/draft", draftBody(4, ["kept", "typed-at-close"]))).ok).toBe(true);
      expect((await saveDocuments(session, [{ path: linked, annotations: [comment("kept-linked"), comment("linked-at-close")] }])).ok).toBe(true);
      // The closed tab's "everything removed" DELETE deletes nothing.
      await fetch(`${session.url}/api/draft?generation=11`, { method: "DELETE" });
      close(session);

      // The next session, after the agent edited the file, gets the comments back.
      const reopened = await openFile("kept.md", "# Kept\n\nv2, edited\n");
      expect(idsOf(await (await fetch(`${reopened.url}/api/draft`)).json())).toEqual(["kept", "typed-at-close"]);
      const linkedCopy = await fetch(`${reopened.url}/api/draft/document?path=${encodeURIComponent(linked)}`);
      expect(idsOf(await linkedCopy.json())).toEqual(["kept-linked", "linked-at-close"]);
    });

    test("the reviewer's Close clears the path copy too", async () => {
      const first = await openFile("close.md", "# Close\n\nv1\n");
      await post(first, "/api/draft", draftBody(1, ["c1"]));
      expect((await fetch(`${first.url}/api/exit?generation=2`, { method: "POST" })).ok).toBe(true);
      close(first);
      const reopened = await openFile("close.md", "# Close\n\nv2\n");
      expect((await fetch(`${reopened.url}/api/draft`)).status).toBe(404);
    });

    test("local-file and folder sessions advertise document copies", async () => {
      const file = await openFile("advert.md", "# Advert\n");
      expect((await (await fetch(`${file.url}/api/plan`)).json()).documentDrafts).toBe(true);
      const folder = await openFolder();
      expect((await (await fetch(`${folder.url}/api/plan`)).json()).documentDrafts).toBe(true);
    });

    test("a URL session has neither a path copy nor document copies", async () => {
      const server = await start({ markdown: "# Page\n", filePath: "https://example.invalid/page" });
      servers.push(server);
      expect((await (await fetch(`${server.url}/api/plan`)).json()).documentDrafts).toBeUndefined();
      expect((await fetch(`${server.url}/api/draft/document?path=${encodeURIComponent(join(docDir, "x.md"))}`)).status).toBe(404);
    });

    test("a file's comments follow it from a folder session into a session on the file alone", async () => {
      const filePath = join(docDir, "a.md");
      writeFileSync(filePath, "# A\n\nBody\n");
      const folder = await openFolder();
      const res = await saveDocuments(folder, [{ path: filePath, annotations: [comment("from-folder")] }]);
      expect(res.ok).toBe(true);
      close(folder);

      const alone = await openFile("a.md", "# A\n\nBody, edited\n");
      expect(idsOf(await (await fetch(`${alone.url}/api/draft`)).json())).toEqual(["from-folder"]);
    });

    test("a file's comments follow it from a single-file session into a folder", async () => {
      const alone = await openFile("b.md", "# B\n\nBody\n");
      await post(alone, "/api/draft", draftBody(1, ["from-file"]));
      close(alone);

      const folder = await openFolder();
      const res = await fetch(`${folder.url}/api/draft/document?path=${encodeURIComponent(join(docDir, "b.md"))}`);
      expect(res.status).toBe(200);
      expect(idsOf(await res.json())).toEqual(["from-file"]);
    });

    test("a folder decision clears the files it covered and refuses later writes", async () => {
      const covered = join(docDir, "covered.md");
      const untouched = join(docDir, "untouched.md");
      writeFileSync(covered, "# C\n");
      writeFileSync(untouched, "# U\n");

      // An earlier session left comments on a file this session never opens.
      const earlier = await openFolder();
      await saveDocuments(earlier, [{ path: untouched, annotations: [comment("keep")] }]);
      close(earlier);

      const folder = await openFolder();
      await saveDocuments(folder, [{ path: covered, annotations: [comment("sent")] }]);
      expect((await post(folder, "/api/feedback", { feedback: "x", annotations: [comment("sent")] })).ok).toBe(true);
      expect((await saveDocuments(folder, [{ path: covered, annotations: [comment("late")] }])).status).toBe(409);
      close(folder);

      const next = await openFolder();
      expect((await fetch(`${next.url}/api/draft/document?path=${encodeURIComponent(covered)}`)).status).toBe(404);
      const kept = await fetch(`${next.url}/api/draft/document?path=${encodeURIComponent(untouched)}`);
      expect(idsOf(await kept.json())).toEqual(["keep"]);
    });

    test("sending a document with no comments clears its copy", async () => {
      const filePath = join(docDir, "cleared.md");
      writeFileSync(filePath, "# Cleared\n");
      const folder = await openFolder();
      await saveDocuments(folder, [{ path: filePath, annotations: [comment("gone")] }]);
      await saveDocuments(folder, [{ path: filePath, annotations: [] }]);
      expect((await fetch(`${folder.url}/api/draft/document?path=${encodeURIComponent(filePath)}`)).status).toBe(404);
    });

    test("paths outside the session, and a single-file session's own file, are refused", async () => {
      const outside = join(root, "elsewhere.md");
      writeFileSync(outside, "# Elsewhere\n");
      const folder = await openFolder();
      expect((await fetch(`${folder.url}/api/draft/document?path=${encodeURIComponent(outside)}`)).status).toBe(403);
      const inside = join(docDir, "inside.md");
      writeFileSync(inside, "# Inside\n");
      const res = await saveDocuments(folder, [
        { path: outside, annotations: [comment("x")] },
        { path: inside, annotations: [comment("y")] },
      ]);
      const body = await res.json();
      expect(body.rejected).toEqual([outside]);
      expect(body.written).toBe(1);

      const alone = await openFile("own.md", "# Own\n");
      const own = await saveDocuments(alone, [{ path: join(docDir, "own.md"), annotations: [comment("z")] }]);
      expect((await own.json()).rejected).toEqual([join(docDir, "own.md")]);
      // A symlink alias of the session's own file is the same file.
      const alias = join(docDir, "own-alias.md");
      symlinkSync(join(docDir, "own.md"), alias);
      expect((await fetch(`${alone.url}/api/draft/document?path=${encodeURIComponent(alias)}`)).status).toBe(403);
    });

    test("only existing regular files get a copy, keyed by their real path", async () => {
      const folder = await openFolder();
      const missing = join(docDir, "missing.md");
      const subdir = join(docDir, "sub");
      mkdirSync(subdir);
      expect((await fetch(`${folder.url}/api/draft/document?path=${encodeURIComponent(missing)}`)).status).toBe(400);
      expect((await fetch(`${folder.url}/api/draft/document?path=${encodeURIComponent(subdir)}`)).status).toBe(400);
      const refused = await (await saveDocuments(folder, [{ path: missing, annotations: [comment("m")] }])).json();
      expect(refused.rejected).toEqual([missing]);

      const real = join(docDir, "real.md");
      const alias = join(docDir, "alias.md");
      writeFileSync(real, "# Real\n");
      symlinkSync(real, alias);
      await saveDocuments(folder, [{ path: alias, annotations: [comment("via-alias")] }]);
      const res = await fetch(`${folder.url}/api/draft/document?path=${encodeURIComponent(real)}`);
      expect(idsOf(await res.json())).toEqual(["via-alias"]);
    });
  });
}
