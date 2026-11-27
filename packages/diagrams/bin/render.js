import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { renderDiagram } from "../dist/index.js";

/** Shared by the standalone npm executable and the Plannotator CLI. */
export async function renderFile(args) {
  const [input, option, output] = args;
  if (args.length !== 3 || !input || !output || !["-o", "--output"].includes(option)) {
    throw new Error("Usage: render <input.diagram.json> -o <output.svg>");
  }
  const source = await realpath(input);
  const target = await stat(output).catch(error => {
    if (error.code !== "ENOENT") throw error;
  });
  if (target) {
    const original = await stat(source);
    if (original.dev === target.dev && original.ino === target.ino) {
      throw new Error("Choose an SVG output path separate from the editable source.");
    }
  }
  const result = await renderDiagram(JSON.parse(await readFile(source, "utf8")));
  await writeFile(output, result.svg);
  return result.problems;
}
