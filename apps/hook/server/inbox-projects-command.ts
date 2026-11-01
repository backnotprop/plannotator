/**
 * `plannotator inbox projects …` (approval "project-combine"): a person asks an
 * agent to clean up their Inbox projects, and the agent lists them, combines
 * one into another, and undoes a combine later. A command and not a tool: every
 * tool's text costs every agent tokens in every session, and this runs seldom.
 *
 * A thin client over the routes the window uses on this computer's listener
 * (`GET /api/inbox/projects`, `GET /api/inbox/tidy`, `POST
 * /api/inbox/projects/:id/combine`), starting a stopped Inbox detached as
 * `plannotator card` does. The rules live once, in the store. A combine remembers
 * nothing here, so an undo works from any session, at any time.
 *
 * stdout: a text answer, or JSON with --json. A refusal goes to stderr as
 * `<code>: <message>` and exits 1; bad usage exits 2.
 */

import { type InboxTidyCombine, isInboxId } from "@plannotator/core/inbox-types";
import type { InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import { INBOX_PROJECTS_USAGE } from "./cli";

export type ParsedProjectsCommand =
  | { ok: true; op: "list" }
  | { ok: true; op: "combine"; project: string; into: string }
  | { ok: true; op: "undo"; project: string }
  | { ok: false; error: string };

export function parseProjectsCommand(argv: readonly string[]): ParsedProjectsCommand {
  const [op, ...rest] = argv;
  if (op === undefined) return { ok: true, op: "list" };
  if (op === "undo") {
    const [project, ...more] = rest;
    if (project === undefined || project.startsWith("--") || more.length > 0) return { ok: false, error: "inbox projects undo takes one project id." };
    return { ok: true, op, project };
  }
  if (op !== "combine") return { ok: false, error: `Unknown inbox projects command: ${op}` };
  const positional: string[] = [];
  let into: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--into") {
      if (into !== null) return { ok: false, error: "--into given twice." };
      into = rest[++i] ?? null;
      if (into === null) return { ok: false, error: "--into takes a project id." };
    } else if (arg.startsWith("--")) return { ok: false, error: `Unknown inbox projects option: ${arg}` };
    else positional.push(arg);
  }
  if (positional.length !== 1 || into === null) return { ok: false, error: "inbox projects combine needs: <project id> --into <project id>." };
  return { ok: true, op, project: positional[0]!, into };
}

interface Member {
  id: string;
  name: string;
  root: string;
}

interface Folder extends Member {
  threads: number;
  combined?: Member[];
}

interface Answer {
  status: number;
  body: Record<string, unknown> | null;
}

export interface ProjectsCommandDeps {
  json: boolean;
  ensureRunning: () => Promise<InboxRegistryEntry>;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

async function request(port: number, path: string, post?: Record<string, unknown>): Promise<Answer> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, post ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(post) } : undefined);
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: response.status, body };
}

const threadCount = (count: number) => `${count} ${count === 1 ? "thread" : "threads"}`;

function listText(folders: readonly Folder[], suggestions: readonly InboxTidyCombine[]): string {
  if (folders.length === 0) return "No projects yet.\n";
  const lines: string[] = [];
  for (const folder of folders) {
    lines.push(`${folder.name}  ${folder.id}`, `  ${folder.root}`, `  ${threadCount(folder.threads)}`);
    if (folder.combined) {
      lines.push("  Combined into it:");
      for (const member of folder.combined) lines.push(`    ${member.name}  ${member.id}  ${member.root}`);
    }
    lines.push("");
  }
  if (suggestions.length > 0) {
    lines.push("Suggested combines:");
    for (const { from, into, why } of suggestions) lines.push(`  ${from.name} into ${into.name}: ${why}`, `    plannotator inbox projects combine ${from.id} --into ${into.id}`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Run `plannotator inbox projects …`; resolves to the exit code. */
export async function runInboxProjectsCommand(argv: readonly string[], deps: ProjectsCommandDeps): Promise<number> {
  const out = deps.out ?? ((text: string) => void process.stdout.write(text));
  const err = deps.err ?? ((text: string) => void process.stderr.write(text));
  if (argv[0] === "--help" || argv[0] === "-h") {
    out(`${INBOX_PROJECTS_USAGE}\n`);
    return 0;
  }
  const parsed = parseProjectsCommand(argv);
  if (!parsed.ok) {
    err(`${parsed.error}\n${INBOX_PROJECTS_USAGE}\n`);
    return 2;
  }
  // A name is the likely slip: the list prints both, and only an id is one project for sure.
  const notAnId = (parsed.op === "combine" ? [parsed.project, parsed.into] : parsed.op === "undo" ? [parsed.project] : []).find((id) => !isInboxId("prj", id));
  if (notAnId !== undefined) {
    err(`validation_error: ${notAnId} is not a project id. Run 'plannotator inbox projects' for the ids (prj_…).\n`);
    return 1;
  }
  const print = (json: unknown, text: string) => out(deps.json ? `${JSON.stringify(json, null, 2)}\n` : text);
  let entry: InboxRegistryEntry;
  try {
    entry = await deps.ensureRunning();
  } catch (error) {
    err(`Plannotator Inbox is not running: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  try {
    const listed = await request(entry.port, "/api/inbox/projects");
    const folders = listed.body?.projects as Folder[] | undefined;
    if (listed.status !== 200 || !folders) {
      err("Plannotator Inbox did not list its projects.\n");
      return 1;
    }
    if (parsed.op === "list") {
      const tidy = await request(entry.port, "/api/inbox/tidy?surface=list");
      const suggestions = (tidy.body?.combine as InboxTidyCombine[] | undefined) ?? [];
      const projects = folders.map(({ id, name, root, threads, combined }) => ({ id, name, root, threads, ...(combined ? { combined } : {}) }));
      print({ projects, suggestions }, listText(folders, suggestions));
      return 0;
    }

    const { project } = parsed;
    /** The project that shows `id`: itself, or the one it is combined into. */
    const headOf = (id: string) => folders.find((folder) => folder.id === id || folder.combined?.some((member) => member.id === id));
    const head = headOf(project);
    const name = head?.id === project ? head.name : (head?.combined?.find((member) => member.id === project)?.name ?? project);
    const refused = (code: string, message: string) => {
      err(`${code}: ${message}\n`);
      return 1;
    };
    const into = parsed.op === "combine" ? parsed.into : null;
    if (into === null && head?.id === project) return refused("not_combined", `${name} is not combined into another project.`);
    if (into !== null && into !== project && head && head.id !== project && head.id === headOf(into)?.id) {
      print({ project: head, changed: false }, `${name} is already in ${head.name}. Nothing changed.\n`);
      return 0;
    }

    const answer = await request(entry.port, `/api/inbox/projects/${encodeURIComponent(project)}/combine`, { serverSession: listed.body?.serverSession, into });
    const shown = answer.body?.project as Folder | null | undefined;
    if (answer.status !== 200 || !shown) {
      // The id was well formed, so `not_found` (not `project_not_found`) means no such route: an Inbox from before combining.
      const code = answer.body?.code;
      if (typeof code !== "string" || code === "not_found") return refused("not_supported", "This Plannotator Inbox is older than this command and cannot combine projects. Tell the person to update it.");
      return refused(code, String(answer.body?.error ?? "The projects did not change."));
    }
    if (into !== null) {
      print({ project: shown, changed: true }, `Combined ${name} into ${shown.name}. To undo: plannotator inbox projects undo ${project}\n`);
      return 0;
    }
    const kept = shown.combined?.map((member) => member.name).join(", ");
    print({ project: shown, changed: true }, `${shown.name} is its own project again${kept ? `, with ${kept} still combined into it` : ""}.\n`);
    return 0;
  } catch (error) {
    err(`Plannotator Inbox did not answer: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
