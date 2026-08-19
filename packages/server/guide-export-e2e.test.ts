/**
 * End-to-end: a guide job launched through the review server can be exported
 * as a portable HTML whose embedded snapshot carries the diff the guide was
 * generated against (decision record D6) — through the live-job path
 * (session launch review) and, after restart, the persisted path
 * (`saved:{id}` from the store).
 *
 * Uses a fake `claude` binary on PATH that returns a valid stream-json result.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUIDE_SNAPSHOT_SCRIPT_ID, parseGuideSnapshotJson } from "@plannotator/shared/guide-format";
import { FIXTURE_PATCH_TS_JSON } from "@plannotator/shared/guide-format-fixtures";
import { deriveGuideRepoKeyFallback, listGuides } from "@plannotator/shared/guide-store";
import { startReviewServer } from "./review";

const SPA_HTML = "<!doctype html><html><body>SPA fallback</body></html>";
const GUIDE_OUTPUT = {
  title: "E2E guide",
  intent: "Exported end to end.",
  sections: [{ title: "Auth", overview: "The guard.", diffs: [{ file: "src/auth.ts", summary: "Adds a guard." }] }],
  unplacedFiles: ["package.json"],
};

let binDir = "";
let dataDir = "";
let previousPath: string | undefined;
let previousDataDir: string | undefined;
let previousPort: string | undefined;
let previousRemote: string | undefined;

beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "plannotator-fake-claude-"));
  // A fake claude: swallow stdin (the prompt) and print one stream-json result line.
  const script = `#!/bin/sh
cat >/dev/null
printf '%s\\n' '{"type":"result","is_error":false,"structured_output":${JSON.stringify(GUIDE_OUTPUT)}}'
`;
  writeFileSync(join(binDir, "claude"), script);
  chmodSync(join(binDir, "claude"), 0o755);
  previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
  previousPort = process.env.PLANNOTATOR_PORT;
  previousRemote = process.env.PLANNOTATOR_REMOTE;
  delete process.env.PLANNOTATOR_PORT;
  process.env.PLANNOTATOR_REMOTE = "0";
});

afterAll(() => {
  if (previousPath === undefined) delete process.env.PATH;
  else process.env.PATH = previousPath;
  if (previousPort === undefined) delete process.env.PLANNOTATOR_PORT;
  else process.env.PLANNOTATOR_PORT = previousPort;
  if (previousRemote === undefined) delete process.env.PLANNOTATOR_REMOTE;
  else process.env.PLANNOTATOR_REMOTE = previousRemote;
  rmSync(binDir, { recursive: true, force: true });
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = previousDataDir;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = "";
});

async function waitForJob(url: string, id: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    const res = await fetch(`${url}/api/agents/jobs`);
    const body = (await res.json()) as { jobs: Array<Record<string, unknown>> };
    const job = body.jobs.find((j) => j.id === id);
    if (job && job.status !== "starting" && job.status !== "running") return job;
    await Bun.sleep(25);
  }
  throw new Error("job did not finish");
}

function embeddedSnapshot(html: string) {
  const m = new RegExp(`<script id="${GUIDE_SNAPSHOT_SCRIPT_ID}" type="application/json">([\\s\\S]*?)</script>`).exec(html);
  const parsed = parseGuideSnapshotJson(m![1]);
  if (!parsed.ok) throw new Error(`${parsed.error.path}: ${parsed.error.message}`);
  return parsed.value;
}

describe("guide export end to end (Bun review server)", () => {
  test("live job → export carries the launch-time diff; after restart the saved guide exports the same", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "plannotator-guide-e2e-"));
    previousDataDir = process.env.PLANNOTATOR_DATA_DIR;
    process.env.PLANNOTATOR_DATA_DIR = dataDir;
    const repoKey = deriveGuideRepoKeyFallback(process.cwd());

    let server = await startReviewServer({ rawPatch: FIXTURE_PATCH_TS_JSON, gitRef: "test..HEAD", origin: "claude-code", htmlContent: SPA_HTML });
    let jobId = "";
    try {
      const launch = await fetch(`${server.url}/api/agents/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "guide", engine: "claude", instructions: "Be brief." }),
      });
      expect(launch.status).toBe(201);
      const { job } = (await launch.json()) as { job: Record<string, unknown> };
      jobId = job.id as string;
      // The patch never rides the broadcast job object.
      expect("launchReview" in job).toBe(false);

      const finished = await waitForJob(server.url, jobId);
      expect(finished.status).toBe("done");

      const info = await fetch(`${server.url}/api/guide/${jobId}/export-info`);
      expect(info.status).toBe(200);
      const infoBody = (await info.json()) as { languages: string[]; filename: string };
      expect(infoBody.languages).toEqual(["json", "typescript"]);
      expect(infoBody.filename).toBe("guided-review-e2e-guide.html");

      const res = await fetch(`${server.url}/api/guide/${jobId}/export`);
      expect(res.status).toBe(200);
      const snapshot = embeddedSnapshot(await res.text());
      expect(snapshot.review.rawPatch).toBe(FIXTURE_PATCH_TS_JSON);
      expect(snapshot.review.gitRef).toBe("test..HEAD");
      expect(snapshot.source.kind).toBe("local");
      expect(snapshot.guide.title).toBe("E2E guide");
      expect(snapshot.guide.unplacedFiles).toEqual(["package.json"]);
      expect(snapshot.generator?.engine).toBe("claude");
      expect(snapshot.generator?.customInstructions).toBe("Be brief.");

      // Persisted beside the guide, so it survives the session.
      const saved = listGuides(repoKey);
      expect(saved.length).toBe(1);
      expect(saved[0].envelope.review?.patchFile).toBe(`${saved[0].id}.patch`);
    } finally {
      server.stop();
    }

    // Restart: the live id is gone, the saved id exports the identical diff.
    server = await startReviewServer({ rawPatch: "", gitRef: "HEAD", origin: "claude-code", htmlContent: SPA_HTML });
    try {
      expect((await fetch(`${server.url}/api/guide/${jobId}/export`)).status).toBe(404);
      const [saved] = listGuides(repoKey);
      const res = await fetch(`${server.url}/api/guide/saved:${saved.id}/export`);
      expect(res.status).toBe(200);
      expect(embeddedSnapshot(await res.text()).review.rawPatch).toBe(FIXTURE_PATCH_TS_JSON);
    } finally {
      server.stop();
    }
  });
});
