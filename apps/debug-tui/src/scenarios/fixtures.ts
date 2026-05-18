import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface WorkspaceFixture {
  root: string;
  markdownPath: string;
  htmlPath: string;
  planPath: string;
  archivePath: string;
  codexHome: string;
  copilotHome: string;
  geminiTranscriptPath: string;
  geminiPlanFilename: string;
  geminiSessionId: string;
  cleanup(): Promise<void>;
}

const PLAN_MARKDOWN = `# Simulator plan

This fixture proves that an agent protocol can create a daemon-backed Plannotator plan session.
`;

export async function createWorkspaceFixture(label: string): Promise<WorkspaceFixture> {
  const root = await mkdtemp(join(tmpdir(), `plannotator-${label}-`));
  const markdownPath = join(root, "docs", "notes.md");
  const htmlPath = join(root, "docs", "page.html");
  const planPath = join(root, "plan.md");
  const archivePath = join(root, "plans");
  const codexHome = join(root, "codex-home");
  const copilotHome = join(root, "copilot-home");
  const geminiSessionId = "session-simulator";
  const geminiPlanFilename = "simulator-plan.md";
  const geminiTranscriptPath = join(root, "gemini", "chats", "session-1.json");

  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(archivePath, { recursive: true });
  await writeFile(markdownPath, "# Notes\n\nAnnotate this markdown fixture.\n");
  await writeFile(htmlPath, "<article><h1>Fixture</h1><p>Annotate this HTML fixture.</p></article>\n");
  await writeFile(planPath, PLAN_MARKDOWN);
  await writeFile(join(archivePath, "approved-plan.md"), "# Approved fixture\n\nArchived plan.\n");

  await createCodexFixture(codexHome);
  await createCopilotFixture(copilotHome, root);
  await createGeminiFixture({
    transcriptPath: geminiTranscriptPath,
    sessionId: geminiSessionId,
    planFilename: geminiPlanFilename,
  });
  await createGitFixture(root);

  return {
    root,
    markdownPath,
    htmlPath,
    planPath,
    archivePath,
    codexHome,
    copilotHome,
    geminiTranscriptPath,
    geminiPlanFilename,
    geminiSessionId,
    cleanup: () => rm(root, { force: true, recursive: true }),
  };
}

async function createCodexFixture(codexHome: string): Promise<void> {
  const threadId = "11111111-1111-4111-8111-111111111111";
  const rolloutDir = join(codexHome, ".codex", "sessions", "2026", "05", "17");
  await mkdir(rolloutDir, { recursive: true });
  const rolloutPath = join(rolloutDir, `rollout-2026-05-17T00-00-00-${threadId}.jsonl`);
  const rows = [
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        turn_id: "turn-1",
        item: { type: "Plan", text: PLAN_MARKDOWN },
      },
    },
  ];
  await writeFile(rolloutPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

async function createCopilotFixture(copilotHome: string, cwd: string): Promise<void> {
  const sessionId = "22222222-2222-4222-8222-222222222222";
  const sessionDir = join(copilotHome, "session-state", sessionId);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, "workspace.yaml"), `cwd: ${cwd}\n`);
  await writeFile(join(sessionDir, "plan.md"), PLAN_MARKDOWN);
}

async function createGeminiFixture({
  transcriptPath,
  sessionId,
  planFilename,
}: {
  transcriptPath: string;
  sessionId: string;
  planFilename: string;
}): Promise<void> {
  const projectTempDir = dirname(dirname(transcriptPath));
  const planDir = join(projectTempDir, sessionId, "plans");
  await mkdir(planDir, { recursive: true });
  await mkdir(join(projectTempDir, "chats"), { recursive: true });
  await writeFile(transcriptPath, "{}\n");
  await writeFile(join(planDir, planFilename), PLAN_MARKDOWN);
}

async function createGitFixture(cwd: string): Promise<void> {
  runGit(cwd, ["init"]);
  runGit(cwd, ["config", "user.email", "simulator@example.com"]);
  runGit(cwd, ["config", "user.name", "Plannotator Simulator"]);
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial simulator fixture"]);
  await writeFile(join(cwd, "docs", "notes.md"), "# Notes\n\nChanged by simulator fixture.\n");
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, stdio: "ignore" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed while preparing simulator fixture`);
  }
}

export function codexThreadId(): string {
  return "11111111-1111-4111-8111-111111111111";
}

export function copilotSessionId(): string {
  return "22222222-2222-4222-8222-222222222222";
}

export function simulatorPlan(): string {
  return PLAN_MARKDOWN;
}
