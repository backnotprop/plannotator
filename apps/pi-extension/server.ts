/**
 * Node-compatible servers for Plannotator Pi extension.
 *
 * Pi loads extensions via jiti (Node.js), so we can't use Bun.serve().
 * These are lightweight node:http servers implementing just the routes
 * each UI needs — plan review, code review, and markdown annotation.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { execSync, spawn } from "node:child_process";
import os from "node:os";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

// ── Helpers ──────────────────────────────────────────────────────────────

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: string) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

function json(res: import("node:http").ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function html(res: import("node:http").ServerResponse, content: string): void {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(content);
}

const DEFAULT_REMOTE_PORT = 19432;

/**
 * Check if running in a remote session (SSH, devcontainer, etc.)
 * Honors PLANNOTATOR_REMOTE env var, or detects SSH_TTY/SSH_CONNECTION.
 */
function isRemoteSession(): boolean {
  const remote = process.env.PLANNOTATOR_REMOTE;
  if (remote === "1" || remote?.toLowerCase() === "true") {
    return true;
  }
  // Legacy SSH detection
  if (process.env.SSH_TTY || process.env.SSH_CONNECTION) {
    return true;
  }
  return false;
}

/**
 * Get the server port to use.
 * - PLANNOTATOR_PORT env var takes precedence
 * - Remote sessions default to 19432 (for port forwarding)
 * - Local sessions use random port
 * Returns { port, portSource } so caller can notify user if needed.
 */
function getServerPort(): { port: number; portSource: "env" | "remote-default" | "random" } {
  const envPort = process.env.PLANNOTATOR_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536) {
      return { port: parsed, portSource: "env" };
    }
    // Invalid port - fall back silently, caller can check env var themselves
  }
  if (isRemoteSession()) {
    return { port: DEFAULT_REMOTE_PORT, portSource: "remote-default" };
  }
  return { port: 0, portSource: "random" };
}

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 500;

async function listenOnPort(server: Server): Promise<{ port: number; portSource: "env" | "remote-default" | "random" }> {
  const result = getServerPort();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(result.port, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const addr = server.address() as { port: number };
      return { port: addr.port, portSource: result.portSource };
    } catch (err: unknown) {
      const isAddressInUse = err instanceof Error && err.message.includes("EADDRINUSE");
      if (isAddressInUse && attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      if (isAddressInUse) {
        const hint = isRemoteSession() ? " (set PLANNOTATOR_PORT to use a different port)" : "";
        throw new Error(`Port ${result.port} in use after ${MAX_RETRIES} retries${hint}`);
      }
      throw err;
    }
  }

  // Unreachable, but satisfies TypeScript
  throw new Error("Failed to bind port");
}

/**
 * Open URL in system browser (Node-compatible, no Bun $ dependency).
 * Honors PLANNOTATOR_BROWSER and BROWSER env vars, matching packages/server/browser.ts.
 * Returns { opened: true } if browser was opened, { opened: false, isRemote: true, url } if remote session.
 */
export function openBrowser(url: string): { opened: boolean; isRemote?: boolean; url?: string } {
  const browser = process.env.PLANNOTATOR_BROWSER || process.env.BROWSER;
  if (isRemoteSession() && !browser) {
    return { opened: false, isRemote: true, url };
  }

  try {
    const platform = process.platform;
    const wsl = platform === "linux" && os.release().toLowerCase().includes("microsoft");

    let cmd: string;
    let args: string[];

    if (browser) {
      if (process.env.PLANNOTATOR_BROWSER && platform === "darwin") {
        cmd = "open";
        args = ["-a", browser, url];
      } else if (platform === "win32" || wsl) {
        cmd = "cmd.exe";
        args = ["/c", "start", "", browser, url];
      } else {
        cmd = browser;
        args = [url];
      }
    } else if (platform === "win32" || wsl) {
      cmd = "cmd.exe";
      args = ["/c", "start", "", url];
    } else if (platform === "darwin") {
      cmd = "open";
      args = [url];
    } else {
      cmd = "xdg-open";
      args = [url];
    }

    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.once("error", () => {});
    child.unref();
    return { opened: true };
  } catch {
    return { opened: false };
  }
}

// ── Version History (Node-compatible, duplicated from packages/server) ──

function sanitizeTag(name: string): string | null {
  if (!name || typeof name !== "string") return null;
  const sanitized = name
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
  return sanitized.length >= 2 ? sanitized : null;
}

function extractFirstHeading(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)$/m);
  if (!match) return null;
  return match[1].trim();
}

function generateSlug(plan: string): string {
  const date = new Date().toISOString().split("T")[0];
  const heading = extractFirstHeading(plan);
  const slug = heading ? sanitizeTag(heading) : null;
  return slug ? `${slug}-${date}` : `plan-${date}`;
}

function detectProjectName(): string {
  try {
    const toplevel = execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    const name = basename(toplevel);
    return sanitizeTag(name) ?? "_unknown";
  } catch {
    // Not a git repo — fall back to cwd
  }
  try {
    const name = basename(process.cwd());
    return sanitizeTag(name) ?? "_unknown";
  } catch {
    return "_unknown";
  }
}

function getHistoryDir(project: string, slug: string): string {
  const historyDir = join(os.homedir(), ".plannotator", "history", project, slug);
  mkdirSync(historyDir, { recursive: true });
  return historyDir;
}

function getNextVersionNumber(historyDir: string): number {
  try {
    const entries = readdirSync(historyDir);
    let max = 0;
    for (const entry of entries) {
      const match = entry.match(/^(\d+)\.md$/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > max) max = num;
      }
    }
    return max + 1;
  } catch {
    return 1;
  }
}

function saveToHistory(
  project: string,
  slug: string,
  plan: string,
): { version: number; path: string; isNew: boolean } {
  const historyDir = getHistoryDir(project, slug);
  const nextVersion = getNextVersionNumber(historyDir);
  if (nextVersion > 1) {
    const latestPath = join(historyDir, `${String(nextVersion - 1).padStart(3, "0")}.md`);
    try {
      const existing = readFileSync(latestPath, "utf-8");
      if (existing === plan) {
        return { version: nextVersion - 1, path: latestPath, isNew: false };
      }
    } catch { /* proceed with saving */ }
  }
  const fileName = `${String(nextVersion).padStart(3, "0")}.md`;
  const filePath = join(historyDir, fileName);
  writeFileSync(filePath, plan, "utf-8");
  return { version: nextVersion, path: filePath, isNew: true };
}

function getPlanVersion(
  project: string,
  slug: string,
  version: number,
): string | null {
  const historyDir = join(os.homedir(), ".plannotator", "history", project, slug);
  const fileName = `${String(version).padStart(3, "0")}.md`;
  const filePath = join(historyDir, fileName);
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function getVersionCount(project: string, slug: string): number {
  const historyDir = join(os.homedir(), ".plannotator", "history", project, slug);
  try {
    const entries = readdirSync(historyDir);
    return entries.filter((e) => /^\d+\.md$/.test(e)).length;
  } catch {
    return 0;
  }
}

function listVersions(
  project: string,
  slug: string,
): Array<{ version: number; timestamp: string }> {
  const historyDir = join(os.homedir(), ".plannotator", "history", project, slug);
  try {
    const entries = readdirSync(historyDir);
    const versions: Array<{ version: number; timestamp: string }> = [];
    for (const entry of entries) {
      const match = entry.match(/^(\d+)\.md$/);
      if (match) {
        const version = parseInt(match[1], 10);
        const filePath = join(historyDir, entry);
        try {
          const stat = statSync(filePath);
          versions.push({ version, timestamp: stat.mtime.toISOString() });
        } catch {
          versions.push({ version, timestamp: "" });
        }
      }
    }
    return versions.sort((a, b) => a.version - b.version);
  } catch {
    return [];
  }
}

function listProjectPlans(
  project: string,
): Array<{ slug: string; versions: number; lastModified: string }> {
  const projectDir = join(os.homedir(), ".plannotator", "history", project);
  try {
    const entries = readdirSync(projectDir, { withFileTypes: true });
    const plans: Array<{ slug: string; versions: number; lastModified: string }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const slugDir = join(projectDir, entry.name);
      const files = readdirSync(slugDir).filter((f) => /^\d+\.md$/.test(f));
      if (files.length === 0) continue;
      let latest = 0;
      for (const file of files) {
        try {
          const mtime = statSync(join(slugDir, file)).mtime.getTime();
          if (mtime > latest) latest = mtime;
        } catch { /* skip */ }
      }
      plans.push({
        slug: entry.name,
        versions: files.length,
        lastModified: latest ? new Date(latest).toISOString() : "",
      });
    }
    return plans.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  } catch {
    return [];
  }
}

// ── Plan Review Server ──────────────────────────────────────────────────

export interface PlanServerResult {
  port: number;
  portSource: "env" | "remote-default" | "random";
  url: string;
  waitForDecision: () => Promise<{ approved: boolean; feedback?: string }>;
  stop: () => void;
}

export async function startPlanReviewServer(options: {
  plan: string;
  htmlContent: string;
  origin?: string;
}): Promise<PlanServerResult> {
  // Version history
  const slug = generateSlug(options.plan);
  const project = detectProjectName();
  const historyResult = saveToHistory(project, slug, options.plan);
  const previousPlan =
    historyResult.version > 1
      ? getPlanVersion(project, slug, historyResult.version - 1)
      : null;
  const versionInfo = {
    version: historyResult.version,
    totalVersions: getVersionCount(project, slug),
    project,
  };

  let resolveDecision!: (result: { approved: boolean; feedback?: string }) => void;
  const decisionPromise = new Promise<{ approved: boolean; feedback?: string }>((r) => {
    resolveDecision = r;
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost`);

    if (url.pathname === "/api/plan/version") {
      const vParam = url.searchParams.get("v");
      if (!vParam) {
        json(res, { error: "Missing v parameter" }, 400);
        return;
      }
      const v = parseInt(vParam, 10);
      if (isNaN(v) || v < 1) {
        json(res, { error: "Invalid version number" }, 400);
        return;
      }
      const content = getPlanVersion(project, slug, v);
      if (content === null) {
        json(res, { error: "Version not found" }, 404);
        return;
      }
      json(res, { plan: content, version: v });
    } else if (url.pathname === "/api/plan/versions") {
      json(res, { project, slug, versions: listVersions(project, slug) });
    } else if (url.pathname === "/api/plan/history") {
      json(res, { project, plans: listProjectPlans(project) });
    } else if (url.pathname === "/api/plan") {
      json(res, { plan: options.plan, origin: options.origin ?? "pi", previousPlan, versionInfo });
    } else if (url.pathname === "/api/approve" && req.method === "POST") {
      const body = await parseBody(req);
      resolveDecision({ approved: true, feedback: body.feedback as string | undefined });
      json(res, { ok: true });
    } else if (url.pathname === "/api/deny" && req.method === "POST") {
      const body = await parseBody(req);
      resolveDecision({ approved: false, feedback: (body.feedback as string) || "Plan rejected" });
      json(res, { ok: true });
    } else {
      html(res, options.htmlContent);
    }
  });

  const { port, portSource } = await listenOnPort(server);

  return {
    port,
    portSource,
    url: `http://localhost:${port}`,
    waitForDecision: () => decisionPromise,
    stop: () => server.close(),
  };
}

export type DiffType = "uncommitted" | "staged" | "unstaged" | "last-commit" | "branch";

export interface DiffOption {
  id: DiffType | "separator";
  label: string;
}

export interface GitContext {
  currentBranch: string;
  defaultBranch: string;
  diffOptions: DiffOption[];
}

export interface ReviewServerResult {
  port: number;
  portSource: "env" | "remote-default" | "random";
  url: string;
  waitForDecision: () => Promise<{ approved: boolean; feedback: string }>;
  stop: () => void;
}

/** Run a git command and return stdout (empty string on error). */
function git(cmd: string): string {
  try {
    return execSync(`git ${cmd}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

export function getGitContext(): GitContext {
  const currentBranch = git("rev-parse --abbrev-ref HEAD") || "HEAD";

  let defaultBranch = "";
  const symRef = git("symbolic-ref refs/remotes/origin/HEAD");
  if (symRef) {
    defaultBranch = symRef.replace("refs/remotes/origin/", "");
  }
  if (!defaultBranch) {
    const hasMain = git("show-ref --verify refs/heads/main");
    defaultBranch = hasMain ? "main" : "master";
  }

  const diffOptions: DiffOption[] = [
    { id: "uncommitted", label: "Uncommitted changes" },
    { id: "last-commit", label: "Last commit" },
  ];
  if (currentBranch !== defaultBranch) {
    diffOptions.push({ id: "branch", label: `vs ${defaultBranch}` });
  }

  return { currentBranch, defaultBranch, diffOptions };
}

export function runGitDiff(diffType: DiffType, defaultBranch = "main"): { patch: string; label: string } {
  switch (diffType) {
    case "uncommitted":
      return { patch: git("diff HEAD --src-prefix=a/ --dst-prefix=b/"), label: "Uncommitted changes" };
    case "staged":
      return { patch: git("diff --staged --src-prefix=a/ --dst-prefix=b/"), label: "Staged changes" };
    case "unstaged":
      return { patch: git("diff --src-prefix=a/ --dst-prefix=b/"), label: "Unstaged changes" };
    case "last-commit":
      return { patch: git("diff HEAD~1..HEAD --src-prefix=a/ --dst-prefix=b/"), label: "Last commit" };
    case "branch":
      return { patch: git(`diff ${defaultBranch}..HEAD --src-prefix=a/ --dst-prefix=b/`), label: `Changes vs ${defaultBranch}` };
    default:
      return { patch: "", label: "Unknown diff type" };
  }
}

export async function startReviewServer(options: {
  rawPatch: string;
  gitRef: string;
  htmlContent: string;
  origin?: string;
  diffType?: DiffType;
  gitContext?: GitContext;
}): Promise<ReviewServerResult> {
  let currentPatch = options.rawPatch;
  let currentGitRef = options.gitRef;
  let currentDiffType: DiffType = options.diffType || "uncommitted";

  let resolveDecision!: (result: { approved: boolean; feedback: string }) => void;
  const decisionPromise = new Promise<{ approved: boolean; feedback: string }>((r) => {
    resolveDecision = r;
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost`);

    if (url.pathname === "/api/diff" && req.method === "GET") {
      json(res, {
        rawPatch: currentPatch,
        gitRef: currentGitRef,
        origin: options.origin ?? "pi",
        diffType: currentDiffType,
        gitContext: options.gitContext,
      });
    } else if (url.pathname === "/api/diff/switch" && req.method === "POST") {
      const body = await parseBody(req);
      const newType = body.diffType as DiffType;
      if (!newType) {
        json(res, { error: "Missing diffType" }, 400);
        return;
      }
      const defaultBranch = options.gitContext?.defaultBranch || "main";
      const result = runGitDiff(newType, defaultBranch);
      currentPatch = result.patch;
      currentGitRef = result.label;
      currentDiffType = newType;
      json(res, { rawPatch: currentPatch, gitRef: currentGitRef, diffType: currentDiffType });
    } else if (url.pathname === "/api/feedback" && req.method === "POST") {
      const body = await parseBody(req);
      resolveDecision({
        approved: (body.approved as boolean) ?? false,
        feedback: (body.feedback as string) || "",
      });
      json(res, { ok: true });
    } else {
      html(res, options.htmlContent);
    }
  });

  const { port, portSource } = await listenOnPort(server);

  return {
    port,
    portSource,
    url: `http://localhost:${port}`,
    waitForDecision: () => decisionPromise,
    stop: () => server.close(),
  };
}

// ── Annotate Server ─────────────────────────────────────────────────────

export interface AnnotateServerResult {
  port: number;
  portSource: "env" | "remote-default" | "random";
  url: string;
  waitForDecision: () => Promise<{ feedback: string }>;
  stop: () => void;
}

export async function startAnnotateServer(options: {
  markdown: string;
  filePath: string;
  htmlContent: string;
  origin?: string;
}): Promise<AnnotateServerResult> {
  let resolveDecision!: (result: { feedback: string }) => void;
  const decisionPromise = new Promise<{ feedback: string }>((r) => {
    resolveDecision = r;
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost`);

    if (url.pathname === "/api/plan" && req.method === "GET") {
      json(res, {
        plan: options.markdown,
        origin: options.origin ?? "pi",
        mode: "annotate",
        filePath: options.filePath,
      });
    } else if (url.pathname === "/api/feedback" && req.method === "POST") {
      const body = await parseBody(req);
      resolveDecision({ feedback: (body.feedback as string) || "" });
      json(res, { ok: true });
    } else {
      html(res, options.htmlContent);
    }
  });

  const { port, portSource } = await listenOnPort(server);

  return {
    port,
    portSource,
    url: `http://localhost:${port}`,
    waitForDecision: () => decisionPromise,
    stop: () => server.close(),
  };
}
