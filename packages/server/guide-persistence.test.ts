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
        const listRes = await fetch(`${server.url}/api/guides`);
        expect(listRes.status).toBe(200);
        const list = await listRes.json() as Array<Record<string, unknown>>;
        expect(list.length).toBe(1);
        expect(list[0].id).toBe("1000-persisted-guide");
        expect(list[0].label).toBe("feature/x");
        expect(list[0].title).toBe(GUIDE.title);
        expect(list[0].progress).toEqual({ reviewed: 0, total: 2 });
        expect(list[0].moved).toBe(false);

        const getRes = await fetch(`${server.url}/api/guide/saved:1000-persisted-guide`);
        expect(getRes.status).toBe(200);
        const data = await getRes.json() as Record<string, unknown>;
        expect(data.title).toBe(GUIDE.title);
        expect((data.sections as unknown[]).length).toBe(2);
        expect(data.reviewed).toEqual([false, false]);
        expect(data.saved).toBe(true);
        expect(data.moved).toBe(false);

        const missingRes = await fetch(`${server.url}/api/guide/saved:2000-missing`);
        expect(missingRes.status).toBe(404);

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

      server = await serverCase.start();
      try {
        const data = await (await fetch(`${server.url}/api/guide/saved:1000-persisted-guide`)).json() as Record<string, unknown>;
        expect(data.reviewed).toEqual([true, false]);

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
        expect(html).toMatch(/<script type="module" src="https:\/\/guides\.show\/v1\/viewer\.[A-Za-z0-9_-]+\.js" integrity="sha384-/);
        expect(html.length).toBeLessThan(20_000);
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
        const evil = await fetch(`${server.url}/api/guide/saved:..%2F..%2Fescape`);
        expect(evil.status).toBe(404);
        const evilDelete = await fetch(`${server.url}/api/guides/..%2Fescape`, { method: "DELETE" });
        expect(evilDelete.status).toBe(404);

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
        const infoBefore = await (await fetch(`${server.url}/api/guide/saved:1000-exportable/share-info`)).json() as Record<string, unknown>;
        expect(infoBefore).toEqual({ enabled: true, serviceUrl: `http://127.0.0.1:${host.port}` });

        const evil = await fetch(`${server.url}/api/guide/saved:1000-exportable/share`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://evil.example" }, body: "{}" });
        expect(evil.status).toBe(403);
        expect(uploads.length).toBe(0);

        expect((await fetch(`${server.url}/api/guide/saved:1000-exportable/share`, { method: "POST", headers: jsonHeaders, body: "not json" })).status).toBe(400);
        expect((await fetch(`${server.url}/api/guide/saved:1000-exportable/share`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ ttlSeconds: -1 }) })).status).toBe(400);
        expect((await fetch(`${server.url}/api/guide/saved:1000-exportable/share`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ public: "yes" }) })).status).toBe(400);

        expect((await fetch(`${server.url}/api/guide/saved:1000-legacy/share`, { method: "POST", headers: jsonHeaders, body: "{}" })).status).toBe(404);
        expect((await fetch(`${server.url}/api/guide/saved:2000-nope/share`, { method: "POST", headers: jsonHeaders, body: "{}" })).status).toBe(404);
        expect(uploads.length).toBe(0);

        const shareRes = await fetch(`${server.url}/api/guide/saved:1000-exportable/share`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({}) });
        expect(shareRes.status).toBe(200);
        const shared = await shareRes.json() as { id: string; url: string; deleteToken: string; expiresAt?: string; bytes: number; recorded: boolean };
        expect(shared.id).toBe("HostId0123456789abcdef");
        expect(shared.deleteToken).toBe("host-del-tok");
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

        const again = await fetch(`${server.url}/api/guide/saved:1000-exportable/share`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ public: true }) });
        expect(again.status).toBe(409);
        expect(((await again.json()) as { url: string }).url).toBe(shared.url);
        expect(uploads.length).toBe(1);
        expect(loadGuide(repoKey, "1000-exportable")!.share!.deleteToken).toBe("host-del-tok");

        expect((await fetch(`${server.url}/api/guide/saved:1000-exportable/share`, { method: "DELETE", headers: { Origin: "http://evil.example" } })).status).toBe(403);
        const del = await fetch(`${server.url}/api/guide/saved:1000-exportable/share`, { method: "DELETE", headers: { Origin: sameOrigin } });
        expect(del.status).toBe(204);
        expect(deletes).toEqual([{ id: "HostId0123456789abcdef", auth: "Bearer host-del-tok" }]);
        expect(loadGuide(repoKey, "1000-exportable")!.share).toBeUndefined();
        expect((await fetch(`${server.url}/api/guide/saved:1000-exportable/share`, { method: "DELETE", headers: { Origin: sameOrigin } })).status).toBe(404);
        expect((await fetch(`${server.url}/api/guide/saved:2000-nope/share`, { method: "DELETE" })).status).toBe(404);

        const publicRes = await fetch(`${server.url}/api/guide/saved:1000-exportable/share`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ public: true, ttlSeconds: 3600 }) });
        expect(publicRes.status).toBe(200);
        const publicUpload = uploads[1].body as { mode: string; data: string; ttlSeconds?: number };
        expect(publicUpload.mode).toBe("plain");
        expect(publicUpload.ttlSeconds).toBe(3600);
        const plainParsed = parseGuideSnapshotJson(publicUpload.data);
        expect(plainParsed.ok).toBe(true);
        expect(((await publicRes.json()) as { url: string }).url).not.toContain("#key=");

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

        const bare = await fetch(`${server.url}/api/guide/saved:1000-exportable/share`, { method: "POST", headers: { Origin: sameOrigin } });
        expect(bare.status).toBe(200);
        expect((uploads[2].body as { mode: string }).mode).toBe("encrypted");

        expect(loadGuide(repoKey, "1000-exportable")!.share).toBeDefined();
        deleteStatus = 404;
        expect((await fetch(`${server.url}/api/guide/saved:1000-exportable/share`, { method: "DELETE" })).status).toBe(204);
        expect(loadGuide(repoKey, "1000-exportable")!.share).toBeUndefined();
        deleteStatus = 204;

        expect((await fetch(`${server.url}/api/guide/saved:1000-exportable/share`, { method: "POST", headers: jsonHeaders, body: "{}" })).status).toBe(200);
        const deletesBefore = deletes.length;
        expect((await fetch(`${server.url}/api/guides/1000-exportable`, { method: "DELETE" })).status).toBe(200);
        expect(deletes.slice(deletesBefore)).toEqual([{ id: "HostId0123456789abcdef", auth: "Bearer host-del-tok" }]);
        expect(loadGuide(repoKey, "1000-exportable")).toBeNull();
        saveGuidePatch(repoKey, "1000-exportable", patch);
        saveGuide(repoKey, "1000-exportable", envelope({
          review: { gitRef: "HEAD", source: { kind: "local", repo: "acme/demo" }, patchFile: "1000-exportable.patch" },
        }));

        const uploadsBefore = uploads.length;
        process.env.PLANNOTATOR_SHARE = "disabled";
        const infoDisabled = await (await fetch(`${server.url}/api/guide/saved:1000-exportable/share-info`)).json() as { enabled: boolean };
        expect(infoDisabled.enabled).toBe(false);
        const disabled = await fetch(`${server.url}/api/guide/saved:1000-exportable/share`, { method: "POST", headers: jsonHeaders, body: "{}" });
        expect(disabled.status).toBe(403);
        expect(await disabled.json()).toEqual({ error: "sharing disabled" });
        expect(uploads.length).toBe(uploadsBefore);
        delete process.env.PLANNOTATOR_SHARE;

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
