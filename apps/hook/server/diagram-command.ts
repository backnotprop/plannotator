import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { gitStdout } from "@plannotator/server/project";
import { SUBCOMMAND_HELP } from "./cli";

async function createDiagram(name: string, cwd: string, dataDir: string): Promise<string> {
  let path: string;
  if (name.endsWith(".diagram.json")) {
    path = resolve(cwd, name);
  } else {
    if (!/^[\p{L}\p{N}][\p{L}\p{N}._ -]*$/u.test(name)) {
      throw new Error("Give a diagram name or an explicit path ending in .diagram.json.");
    }
    const gitDir = await gitStdout(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd).catch(() => null);
    const project = await realpath(gitDir?.trim() || cwd);
    const key = createHash("sha256").update(project).digest("hex").slice(0, 16);
    path = resolve(dataDir, "diagrams", key, name + ".diagram.json");
  }
  const title = basename(path, ".diagram.json");
  const starter = {
    id: randomUUID(), title,
    columns: [{id:"source",title:"Source"}, {id:"destination",title:"Destination"}],
    links: [{id:"handoff",from:"source",to:"destination"}],
  };
  await mkdir(dirname(path), {recursive:true});
  await writeFile(path, JSON.stringify(starter, null, 2) + "\n", {flag:"wx"});
  return path;
}

export async function runDiagramCommand(args: string[], cwd: string, dataDir: string): Promise<number> {
  const [command, ...rest] = args;
  if (!command || args.includes("--help") || args.includes("-h")) {
    console.log(SUBCOMMAND_HELP.diagram);
    return 0;
  }
  try {
    if (command === "new" && rest.length === 1) {
      console.log(await createDiagram(rest[0], cwd, dataDir));
      return 0;
    }
    if (command === "render" && rest.length === 3) {
      const { renderFile } = await import("@plannotator/diagrams/cli");
      const problems = await renderFile([resolve(cwd, rest[0]), rest[1], resolve(cwd, rest[2])]);
      for (const problem of problems) console.error(problem);
      return problems.length ? 1 : 0;
    }
    throw new Error(SUBCOMMAND_HELP.diagram);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
