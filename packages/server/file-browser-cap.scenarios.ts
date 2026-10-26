/**
 * The annotate file browser over a folder that holds more supported files
 * than PLANNOTATOR_FILE_BROWSER_MAX_FILES: GET /api/reference/files on a real
 * annotate folder session says it left files out (`truncated`, `fileLimit`),
 * lists the folder's top levels first (breadth-first), and never counts the
 * heavy folders. Shared by the Bun suite (file-browser-cap.test.ts) and the Pi
 * mirror (apps/pi-extension/server/file-browser-cap.test.ts).
 *
 * Every test runs under a temp PLANNOTATOR_DATA_DIR; nothing touches the real
 * ~/.plannotator.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FileBrowserCapServer {
  url: string;
  stop: () => void;
}

export type StartFileBrowserCapServer = (options: {
  markdown: string;
  filePath: string;
  project: string;
  mode: "annotate-folder";
  folderPath: string;
}) => Promise<FileBrowserCapServer>;

const ENV_KEYS = [
  "PLANNOTATOR_DATA_DIR",
  "PLANNOTATOR_PORT",
  "PLANNOTATOR_REMOTE",
  "PLANNOTATOR_AI",
  "PLANNOTATOR_FILE_BROWSER_MAX_FILES",
] as const;

interface TreeNode {
  name: string;
  path: string;
  type: "file" | "folder";
  children?: TreeNode[];
}

interface FilesPayload {
  tree: TreeNode[];
  truncated: boolean;
  fileLimit: number;
}

function filesOf(nodes: TreeNode[]): string[] {
  return nodes.flatMap((node) => (node.type === "file" ? [node.path] : filesOf(node.children ?? [])));
}

/**
 * README.md, notes.md and docs/{guide,plan}.md near the top; aaa-archive holds
 * 40 files four folders down, named so a name-order depth-first walk would
 * reach it before everything else; node_modules holds 50 that must never count.
 */
function seedFolder(root: string): void {
  writeFileSync(join(root, "README.md"), "# Top\n");
  writeFileSync(join(root, "notes.md"), "# Notes\n");
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "guide.md"), "# Guide\n");
  writeFileSync(join(root, "docs", "plan.md"), "# Plan\n");
  const deep = join(root, "aaa-archive", "2019", "q1", "raw");
  mkdirSync(deep, { recursive: true });
  for (let i = 0; i < 40; i++) writeFileSync(join(deep, `entry-${String(i).padStart(2, "0")}.md`), `# ${i}\n`);
  const heavy = join(root, "node_modules", "pkg");
  mkdirSync(heavy, { recursive: true });
  for (let i = 0; i < 50; i++) writeFileSync(join(heavy, `readme-${i}.md`), `# ${i}\n`);
}

/**
 * `defaultCap`: the cap with PLANNOTATOR_FILE_BROWSER_MAX_FILES unset. Bun
 * keeps 5,000; Pi's file browser never had a cap, so it lists every file
 * unless the variable is set (null).
 */
export function defineFileBrowserCapScenarios(
  runtime: string,
  start: StartFileBrowserCapServer,
  defaultCap: number | null,
): void {
  describe(`${runtime} annotate file browser over its file cap`, () => {
    const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
    let root = "";
    let folder = "";
    const servers: FileBrowserCapServer[] = [];

    beforeEach(() => {
      for (const key of ENV_KEYS) saved[key] = process.env[key];
      root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-file-cap-")));
      process.env.PLANNOTATOR_DATA_DIR = join(root, "data");
      delete process.env.PLANNOTATOR_PORT;
      process.env.PLANNOTATOR_REMOTE = "0";
      process.env.PLANNOTATOR_AI = "disabled";
      delete process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES;
      folder = join(root, "folder");
      mkdirSync(folder);
      seedFolder(folder);
    });

    afterEach(() => {
      for (const server of servers.splice(0)) server.stop();
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key]!;
      }
      rmSync(root, { recursive: true, force: true });
    });

    async function list(): Promise<FilesPayload> {
      const server = await start({ markdown: "", filePath: folder, project: "file-cap-test", mode: "annotate-folder", folderPath: folder });
      servers.push(server);
      const res = await fetch(`${server.url}/api/reference/files?dirPath=${encodeURIComponent(folder)}`);
      expect(res.status).toBe(200);
      return (await res.json()) as FilesPayload;
    }

    test("under the cap: every supported file, not truncated, heavy folders skipped", async () => {
      const data = await list();
      expect(data.truncated).toBe(false);
      if (defaultCap === null) expect(data.fileLimit).toBeUndefined();
      else expect(data.fileLimit).toBe(defaultCap);
      const files = filesOf(data.tree);
      expect(files).toHaveLength(44);
      expect(files.some((file) => file.startsWith("node_modules/"))).toBe(false);
    });

    test(`variable unset, over 5,000 files: ${defaultCap === null ? "every file is listed" : `capped at ${defaultCap}`}`, async () => {
      const bulk = join(folder, "bulk");
      mkdirSync(bulk);
      for (let i = 0; i < 5_010; i++) writeFileSync(join(bulk, `n-${i}.md`), "x\n");
      const data = await list();
      const files = filesOf(data.tree);
      if (defaultCap === null) {
        expect(data.truncated).toBe(false);
        expect(data.fileLimit).toBeUndefined();
        expect(files).toHaveLength(5_054);
      } else {
        expect(data.truncated).toBe(true);
        expect(data.fileLimit).toBe(defaultCap);
        expect(files).toHaveLength(defaultCap);
      }
    });

    test("over the cap: truncated with the cap, and the top levels are the files listed", async () => {
      process.env.PLANNOTATOR_FILE_BROWSER_MAX_FILES = "10";
      const data = await list();
      expect(data.truncated).toBe(true);
      expect(data.fileLimit).toBe(10);
      const files = filesOf(data.tree);
      expect(files).toHaveLength(10);
      for (const file of ["README.md", "notes.md", "docs/guide.md", "docs/plan.md"]) expect(files).toContain(file);
      expect(files.some((file) => file.startsWith("node_modules/"))).toBe(false);
      // Breadth-first in name order: the six deep files that fill the rest are the first six by name.
      expect(files.filter((file) => file.startsWith("aaa-archive/"))).toEqual(
        Array.from({ length: 6 }, (_, i) => `aaa-archive/2019/q1/raw/entry-0${i}.md`),
      );
    });
  });
}
