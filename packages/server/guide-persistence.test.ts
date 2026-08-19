/**
 * Endpoint wiring for durable guide persistence (#1112), against BOTH server
 * runtimes (Bun packages/server/review.ts and the Pi mirror
 * apps/pi-extension/server/serverReview.ts):
 *
 *   GET    /api/guides                    — repo-scoped list
 *   GET    /api/guide/saved:{id}          — serve a persisted guide
 *   PUT    /api/guide/saved:{id}/reviewed — persist reviewed state
 *   DELETE /api/guides/:id                — remove a saved guide
 *   POST   /api/guide/:id/share           — upload to the guide host, record the link
 *   GET    /api/guide/:id/share-info      — enabled / serviceUrl / existing link
 *   DELETE /api/guide/:id/share           — remove on the host, forget the link
 *
 * Both servers are started with no gitContext/PR, so the guide store derives
 * its repo key via the no-remote fallback (process.cwd()) — the tests seed the
 * store through @plannotator/shared/guide-store under that same key.
 *
 * Requires `bash apps/pi-extension/vendor.sh` to have been run (same as the
 * other cross-runtime tests).
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeGuideOutput } from "@plannotator/shared/guide";
import {
  deriveGuideRepoKeyFallback,
  listGuides,
  loadGuide,
  saveGuide,
  saveGuidePatch,
  updateGuideShare,
  type SavedGuideEnvelope,
} from "@plannotator/shared/guide-store";
import { GUIDE_SNAPSHOT_SCRIPT_ID, parseGuideSnapshot, parseGuideSnapshotJson } from "@plannotator/shared/guide-format";
import { decompress } from "@plannotator/shared/compress";
import { decrypt } from "@plannotator/shared/crypto";
import { startReviewServer as startBunReviewServer } from "./review";
import { startReviewServer as startPiReviewServer } from "../../apps/pi-extension/server";

const SPA_HTML = "<!doctype html><html><body>SPA fallback</body></html>";

const GUIDE: CodeGuideOutput = {
  title: "Persisted guide",
  intent: "Round-trips through the saved: endpoints.",
  sections: [
    { title: "Core", overview: "The heart.", diffs: [{ file: "a.ts" }] },
    { title: "Glue", overview: "Wiring.", diffs: [{ file: "b.ts" }] },
  ],
};

function envelope(overrides: Partial<SavedGuideEnvelope> = {}): SavedGuideEnvelope {
  return {
    version: 1,
    savedAt: 1000,
    label: "feature/x",
    title: GUIDE.title,
    guide: GUIDE,
    reviewed: [false, false],
    ...overrides,
  };
}

interface RunningServer {
  readonly url: string;
  stop(): void;
}

const serverCases = [
  {
    name: "Bun review",
    start: () =>
      startBunReviewServer({
        rawPatch: "",
        gitRef: "HEAD",
        origin: "claude-code",
        htmlContent: SPA_HTML,
      }),
  },
  {
    name: "Pi review",
    start: () =>
      startPiReviewServer({
        rawPatch: "",
        gitRef: "HEAD",
        origin: "pi",
        htmlContent: SPA_HTML,
      }),
  },
] as const;

let dataDir = "";
let previousDataDir: string | undefined;
let previousPort: string | undefined;
let previousRemote: string | undefined;
// Both servers run with no gitContext/PR/workspace, so the session's repo key
// is the fallback derivation over process.cwd().
const repoKey = deriveGuideRepoKeyFallback(process.cwd());

beforeAll(() => {
  previousPort = process.env.PLANNOTATOR_PORT;
  previousRemote = process.env.PLANNOTATOR_REMOTE;
  delete process.env.PLANNOTATOR_PORT;
  process.env.PLANNOTATOR_REMOTE = "0";
});

afterAll(() => {
  if (previousPort === undefined) delete process.env.PLANNOTATOR_PORT;
  else process.env.PLANNOTATOR_PORT = previousPort;
  if (previousRemote === undefined) delete process.env.PLANNOTATOR_REMOTE;
  else process.env.PLANNOTATOR_REMOTE = previousRemote;
});

// Fresh data dir per test so seeded guides never leak across cases.
function useTempDataDir() {
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-guide-endpoints-"));
  previousDataDir = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
}

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = previousDataDir;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = "";
});

for (const serverCase of serverCases) {
  describe(`${serverCase.name} guide persistence endpoints`, () => {
    test("lists, serves, updates reviewed (persisted across restart), and deletes saved guides", async () => {
      useTempDataDir();
      saveGuide(repoKey, "1000-persisted-guide", envelope());

      let server = await serverCase.start();
      try {
        // GET /api/guides — the seeded guide is listed with progress + moved.
        const listRes = await fetch(`${server.url}/api/guides`);
        expect(listRes.status).toBe(200);
        const list = await listRes.json() as Array<Record<string, unknown>>;
        expect(list.length).toBe(1);
        expect(list[0].id).toBe("1000-persisted-guide");
        expect(list[0].label).toBe("feature/x");
        expect(list[0].title).toBe(GUIDE.title);
        expect(list[0].progress).toEqual({ reviewed: 0, total: 2 });
        expect(list[0].moved).toBe(false); // no headSha stored → never flagged

        // GET /api/guide/saved:{id} — full guide + reviewed + saved/moved.
        const getRes = await fetch(`${server.url}/api/guide/saved:1000-persisted-guide`);
        expect(getRes.status).toBe(200);
        const data = await getRes.json() as Record<string, unknown>;
        expect(data.title).toBe(GUIDE.title);
        expect((data.sections as unknown[]).length).toBe(2);
        expect(data.reviewed).toEqual([false, false]);
        expect(data.saved).toBe(true);
        expect(data.moved).toBe(false);

        // Unknown saved id → 404.
        const missingRes = await fetch(`${server.url}/api/guide/saved:2000-missing`);
        expect(missingRes.status).toBe(404);

        // PUT /api/guide/saved:{id}/reviewed persists to disk.
        const putRes = await fetch(`${server.url}/api/guide/saved:1000-persisted-guide/reviewed`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reviewed: [true, false] }),
        });
        expect(putRes.status).toBe(200);
        expect(loadGuide(repoKey, "1000-persisted-guide")!.reviewed).toEqual([true, false]);
      } finally {
        server.stop();
      }

      // Server restart — the reviewed state survives on the new session.
      server = await serverCase.start();
      try {
        const data = await (await fetch(`${server.url}/api/guide/saved:1000-persisted-guide`)).json() as Record<string, unknown>;
        expect(data.reviewed).toEqual([true, false]);

        // DELETE /api/guides/:id removes it; a repeat delete 404s.
        const delRes = await fetch(`${server.url}/api/guides/1000-persisted-guide`, { method: "DELETE" });
        expect(delRes.status).toBe(200);
        expect(listGuides(repoKey).length).toBe(0);
        const delAgain = await fetch(`${server.url}/api/guides/1000-persisted-guide`, { method: "DELETE" });
        expect(delAgain.status).toBe(404);
        const listAfter = await (await fetch(`${server.url}/api/guides`)).json() as unknown[];
        expect(listAfter).toEqual([]);
      } finally {
        server.stop();
      }
    });

    test("exports a saved guide as portable HTML pinned to the viewer, and refuses one whose diff was not retained", async () => {
      useTempDataDir();
      const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
      // A guide saved WITH its launch review (patch beside the envelope).
      saveGuidePatch(repoKey, "1000-exportable", patch);
      saveGuide(repoKey, "1000-exportable", envelope({
        engine: "claude",
        model: "sonnet",
        generatedAt: 1234,
        customInstructions: "Focus on auth.",
        review: {
          gitRef: "origin/main..HEAD",
          diffType: "since-base",
          base: "origin/main",
          source: { kind: "local", repo: "acme/demo", branch: "feature/x" },
          patchFile: "1000-exportable.patch",
        },
      }));
      // A pre-portable guide: no review block, no patch → not exportable.
      saveGuide(repoKey, "1000-legacy", envelope({ title: "Legacy" }));

      const server = await serverCase.start();
      try {
        const info = await fetch(`${server.url}/api/guide/saved:1000-exportable/export-info`);
        expect(info.status).toBe(200);
        const infoBody = await info.json() as { bytes: number; filename: string; languages: string[] };
        expect(infoBody.filename).toBe("guided-review-persisted-guide.html");
        expect(infoBody.languages).toEqual(["typescript"]);
        expect(infoBody.bytes).toBeGreaterThan(1000);

        const res = await fetch(`${server.url}/api/guide/saved:1000-exportable/export`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/html");
        expect(res.headers.get("content-disposition")).toContain('filename="guided-review-persisted-guide.html"');
        const html = await res.text();
        // Pins the viewer this build ships (script + integrity) — never inlines it.
        expect(html).toMatch(/<script type="module" src="https:\/\/guides\.show\/v1\/viewer\.[A-Za-z0-9_-]+\.js" integrity="sha384-/);
        expect(html.length).toBeLessThan(20_000);
        // The embedded snapshot is exactly the saved guide + the retained diff + provenance.
        const embedded = new RegExp(`<script id="${GUIDE_SNAPSHOT_SCRIPT_ID}" type="application/json">([\\s\\S]*?)</script>`).exec(html)![1];
        const parsed = parseGuideSnapshotJson(embedded);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) {
          expect(parsed.value.review.rawPatch).toBe(patch);
          expect(parsed.value.review.gitRef).toBe("origin/main..HEAD");
          expect(parsed.value.source).toEqual({ kind: "local", repo: "acme/demo", branch: "feature/x" });
          expect(parsed.value.generator).toEqual({
            engine: "claude",
            model: "sonnet",
            generatedAt: new Date(1234).toISOString(),
            customInstructions: "Focus on auth.",
          });
          expect(parsed.value.guide.sections.length).toBe(2);
        }

        // Legacy envelope → 404 with the honest reason; unknown ids → 404.
        const legacy = await fetch(`${server.url}/api/guide/saved:1000-legacy/export`);
        expect(legacy.status).toBe(404);
        expect(((await legacy.json()) as { error: string }).error).toContain("not retained");
        expect((await fetch(`${server.url}/api/guide/saved:2000-nope/export-info`)).status).toBe(404);
        expect((await fetch(`${server.url}/api/guide/live-unknown/export`)).status).toBe(404);
      } finally {
        server.stop();
      }
    });

    test("traversal-shaped ids are rejected and corrupt files load as no guide", async () => {
      useTempDataDir();
      const server = await serverCase.start();
      try {
        // Traversal-shaped ids never reach the disk layer.
        const evil = await fetch(`${server.url}/api/guide/saved:..%2F..%2Fescape`);
        expect(evil.status).toBe(404);
        const evilDelete = await fetch(`${server.url}/api/guides/..%2Fescape`, { method: "DELETE" });
        expect(evilDelete.status).toBe(404);

        // A live (non-saved) job id still routes to the in-memory session.
        const live = await fetch(`${server.url}/api/guide/some-live-job-id`);
        expect(live.status).toBe(404);
        expect(await live.json()).toEqual({ error: "Guide not found" });
      } finally {
        server.stop();
      }
    });

    test("share: uploads encrypted by default, records the link, share-info reports it, DELETE removes it; guard, disabled and 404 paths", async () => {
      useTempDataDir();
      const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
      saveGuidePatch(repoKey, "1000-exportable", patch);
      saveGuide(repoKey, "1000-exportable", envelope({
        review: { gitRef: "HEAD", source: { kind: "local", repo: "acme/demo" }, patchFile: "1000-exportable.patch" },
      }));
      saveGuide(repoKey, "1000-legacy", envelope({ title: "Legacy" }));

      // A stand-in guide host: records uploads, answers like the contract.
      const uploads: Array<{ body: Record<string, unknown> }> = [];
      const deletes: Array<{ id: string; auth: string | null }> = [];
      let deleteStatus = 204;
      const host = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        async fetch(req) {
          const u = new URL(req.url);
          if (u.pathname === "/api/g" && req.method === "POST") {
            uploads.push({ body: await req.json() as Record<string, unknown> });
            return Response.json({ id: "HostId0123456789abcdef", url: `${u.origin}/g/HostId0123456789abcdef`, deleteToken: "host-del-tok" }, { status: 201 });
          }
          const m = u.pathname.match(/^\/api\/g\/([^/]+)$/);
          if (m && req.method === "DELETE") {
            deletes.push({ id: m[1], auth: req.headers.get("authorization") });
            return new Response(null, { status: deleteStatus });
          }
          return new Response("nope", { status: 404 });
        },
      });
      const previousShareUrl = process.env.PLANNOTATOR_GUIDE_SHARE_URL;
      const previousShare = process.env.PLANNOTATOR_SHARE;
      process.env.PLANNOTATOR_GUIDE_SHARE_URL = `http://127.0.0.1:${host.port}`;
      delete process.env.PLANNOTATOR_SHARE;
      const server = await serverCase.start();
      const sameOrigin = new URL(server.url).origin;
      const jsonHeaders = { "Content-Type": "application/json", Origin: sameOrigin };
      try {
        // Nothing shared yet.
        const infoBefore = await (await fetch(`${server.url}/api/guide/saved:1000-exportable/share-info`)).json() as Record<string, unknown>;
        expect(infoBefore).toEqual({ enabled: true, serviceUrl: `http://127.0.0.1:${host.port}` });

        // Cross-origin POSTs never reach the host.
        const evil = await fetch(`${server.url}/api/guide/saved:1000-exportable/share`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://evil.example" }, body: "{}" });
        expect(evil.status).toBe(403);
        expect(uploads.length).toBe(0);

        // Bad bodies are 400s.
        expect((await fetch(`${server.url}/api/guide/saved:1000-exportable/share`, { method: "POST", headers: jsonHeaders, body: "not json" })).status).toBe(400);
        expect((await fetch(`${server.url}/api/guide/saved:1000-exportable/share`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ ttlSeconds: -1 }) })).status).toBe(400);
        expect((await fetch(`${server.url}/api/guide/saved:1000-exportable/share`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ public: "yes" }) })).status).toBe(400);

        // Not exportable → 404, no upload.
        expect((await fetch(`${server.url}/api/guide/saved:1000-legacy/share`, { method: "POST", headers: jsonHeaders, body: "{}" })).status).toBe(404);
        expect((await fetch(`${server.url}/api/guide/saved:2000-nope/share`, { method: "POST", headers: jsonHeaders, body: "{}" })).status).toBe(404);
        expect(uploads.length).toBe(0);

        // Encrypted by default: the host stores ciphertext; the URL carries the key; the envelope remembers the link.
        const shareRes = await fetch(`${server.url}/api/guide/saved:1000-exportable/share`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({}) });
        expect(shareRes.status).toBe(200);
        const shared = await shareRes.json() as { id: string; url: string; deleteToken: string; expiresAt?: string; bytes: number; recorded: boolean };
        expect(shared.id).toBe("HostId0123456789abcdef");
        expect(shared.deleteToken).toBe("host-del-tok");
        // The saved envelope took the record, so this Plannotator can remove the link later.
        expect(shared.recorded).toBe(true);
        expect(shared.url.startsWith(`http://127.0.0.1:${host.port}/g/HostId0123456789abcdef#key=`)).toBe(true);
        expect(uploads.length).toBe(1);
        const upload = uploads[0].body as { mode: string; data: string; viewer: Record<string, unknown>; ttlSeconds?: number };
        expect(upload.mode).toBe("encrypted");
        expect(upload.ttlSeconds).toBeUndefined();
        expect(typeof upload.viewer.js).toBe("string");
        expect("baseUrl" in upload.viewer).toBe(false);
        expect(shared.bytes).toBe(upload.data.length);
        const key = new URLSearchParams(new URL(shared.url).hash.slice(1)).get("key")!;
        const restored = parseGuideSnapshot(await decompress(await decrypt(upload.data, key)));
        expect(restored.ok).toBe(true);
        if (restored.ok) expect(restored.value.review.rawPatch).toBe(patch);
        const record = loadGuide(repoKey, "1000-exportable")!.share!;
        expect(record).toMatchObject({ id: "HostId0123456789abcdef", url: shared.url, deleteToken: "host-del-tok", serviceUrl: `http://127.0.0.1:${host.port}` });
        expect(Number.isNaN(Date.parse(record.createdAt))).toBe(false);

        const infoAfter = await (await fetch(`${server.url}/api/guide/saved:1000-exportable/share-info`)).json() as { existing?: { url: string; createdAt: string } };
        expect(infoAfter.existing).toEqual({ url: shared.url, createdAt: record.createdAt });

        // One link per guide: a second POST is 409 and uploads nothing, so the
        // first link (whose token only the record holds) is never orphaned.
        const again = await fetch(`${server.url}/api/guide/saved:1000-exportable/share`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ public: true }) });
        expect(again.status).toBe(409);
        expect(((await again.json()) as { url: string }).url).toBe(shared.url);
        expect(uploads.length).toBe(1);
        expect(loadGuide(repoKey, "1000-exportable")!.share!.deleteToken).toBe("host-del-tok");

        // Cross-origin DELETE is refused; a same-origin DELETE removes on the host and forgets the link.
        expect((await fetch(`${server.url}/api/guide/saved:1000-exportable/share`, { method: "DELETE", headers: { Origin: "http://evil.example" } })).status).toBe(403);
        const del = await fetch(`${server.url}/api/guide/saved:1000-exportable/share`, { method: "DELETE", headers: { Origin: sameOrigin } });
        expect(del.status).toBe(204);
        expect(deletes).toEqual([{ id: "HostId0123456789abcdef", auth: "Bearer host-del-tok" }]);
        expect(loadGuide(repoKey, "1000-exportable")!.share).toBeUndefined();
        expect((await fetch(`${server.url}/api/guide/saved:1000-exportable/share`, { method: "DELETE", headers: { Origin: sameOrigin } })).status).toBe(404);
        expect((await fetch(`${server.url}/api/guide/saved:2000-nope/share`, { method: "DELETE" })).status).toBe(404);

        // public + ttl → plain upload with ttlSeconds.
        const publicRes = await fetch(`${server.url}/api/guide/saved:1000-exportable/share`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ public: true, ttlSeconds: 3600 }) });
        expect(publicRes.status).toBe(200);
        const publicUpload = uploads[1].body as { mode: string; data: string; ttlSeconds?: number };
        expect(publicUpload.mode).toBe("plain");
        expect(publicUpload.ttlSeconds).toBe(3600);
        const plainParsed = parseGuideSnapshotJson(publicUpload.data);
        expect(plainParsed.ok).toBe(true);
        expect(((await publicRes.json()) as { url: string }).url).not.toContain("#key=");

        // Removal goes to the host the link was created on, not the configured
        // one: a record from another shell (a different PLANNOTATOR_GUIDE_SHARE_URL)
        // still deletes on its own host, and a 404 from the wrong host must not
        // forget the link.
        const otherDeletes: string[] = [];
        const otherHost = Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          fetch(req) {
            const m = new URL(req.url).pathname.match(/^\/api\/g\/([^/]+)$/);
            if (m && req.method === "DELETE") {
              otherDeletes.push(m[1]);
              return new Response(null, { status: 204 });
            }
            return new Response("nope", { status: 404 });
          },
        });
        try {
          const current = loadGuide(repoKey, "1000-exportable")!.share!;
          updateGuideShare(repoKey, "1000-exportable", { ...current, serviceUrl: `http://127.0.0.1:${otherHost.port}` });
          expect((await fetch(`${server.url}/api/guide/saved:1000-exportable/share`, { method: "DELETE", headers: { Origin: sameOrigin } })).status).toBe(204);
          expect(otherDeletes).toEqual(["HostId0123456789abcdef"]);
          expect(deletes.length).toBe(1);
          expect(loadGuide(repoKey, "1000-exportable")!.share).toBeUndefined();
        } finally {
          otherHost.stop(true);
        }

        // Every body field is optional, so no body at all shares with the defaults.
        const bare = await fetch(`${server.url}/api/guide/saved:1000-exportable/share`, { method: "POST", headers: { Origin: sameOrigin } });
        expect(bare.status).toBe(200);
        expect((uploads[2].body as { mode: string }).mode).toBe("encrypted");

        // A link the host already forgot (expired) is still cleared locally.
        expect(loadGuide(repoKey, "1000-exportable")!.share).toBeDefined();
        deleteStatus = 404;
        expect((await fetch(`${server.url}/api/guide/saved:1000-exportable/share`, { method: "DELETE" })).status).toBe(204);
        expect(loadGuide(repoKey, "1000-exportable")!.share).toBeUndefined();
        deleteStatus = 204;

        // Deleting a saved guide takes its link down with it (the envelope
        // held the only copy of the delete token).
        expect((await fetch(`${server.url}/api/guide/saved:1000-exportable/share`, { method: "POST", headers: jsonHeaders, body: "{}" })).status).toBe(200);
        const deletesBefore = deletes.length;
        expect((await fetch(`${server.url}/api/guides/1000-exportable`, { method: "DELETE" })).status).toBe(200);
        expect(deletes.slice(deletesBefore)).toEqual([{ id: "HostId0123456789abcdef", auth: "Bearer host-del-tok" }]);
        expect(loadGuide(repoKey, "1000-exportable")).toBeNull();
        saveGuidePatch(repoKey, "1000-exportable", patch);
        saveGuide(repoKey, "1000-exportable", envelope({
          review: { gitRef: "HEAD", source: { kind: "local", repo: "acme/demo" }, patchFile: "1000-exportable.patch" },
        }));

        // Sharing disabled: share-info says so, POST is 403 and nothing is uploaded.
        const uploadsBefore = uploads.length;
        process.env.PLANNOTATOR_SHARE = "disabled";
        const infoDisabled = await (await fetch(`${server.url}/api/guide/saved:1000-exportable/share-info`)).json() as { enabled: boolean };
        expect(infoDisabled.enabled).toBe(false);
        const disabled = await fetch(`${server.url}/api/guide/saved:1000-exportable/share`, { method: "POST", headers: jsonHeaders, body: "{}" });
        expect(disabled.status).toBe(403);
        expect(await disabled.json()).toEqual({ error: "sharing disabled" });
        expect(uploads.length).toBe(uploadsBefore);
        delete process.env.PLANNOTATOR_SHARE;

        // Host down → 502 with a reason, and no record is written.
        host.stop(true);
        const down = await fetch(`${server.url}/api/guide/saved:1000-exportable/share`, { method: "POST", headers: jsonHeaders, body: "{}" });
        expect(down.status).toBe(502);
        expect(((await down.json()) as { error: string }).error).toContain("unreachable");
        expect(loadGuide(repoKey, "1000-exportable")!.share).toBeUndefined();
      } finally {
        server.stop();
        host.stop(true);
        if (previousShareUrl === undefined) delete process.env.PLANNOTATOR_GUIDE_SHARE_URL;
        else process.env.PLANNOTATOR_GUIDE_SHARE_URL = previousShareUrl;
        if (previousShare === undefined) delete process.env.PLANNOTATOR_SHARE;
        else process.env.PLANNOTATOR_SHARE = previousShare;
      }
    });
  });
}
