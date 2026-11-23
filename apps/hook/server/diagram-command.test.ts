import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDiagramCommand } from "./diagram-command";

test("new preserves edited source and render gives an editable file an SVG sibling", async () => {
  const folder = await mkdtemp(join(tmpdir(), "diagram-authoring-"));
  try {
    const target = join(folder, "checkout.diagram.json");
    const invoke = (...args: string[]) => runDiagramCommand(args, folder, join(folder, "data"));
    expect(await invoke("new", "./checkout.diagram.json")).toBe(0);
    const spec = JSON.parse(await readFile(target, "utf8"));
    const edited = JSON.stringify({...spec, title:"Checkout edited"});
    await writeFile(target, edited);
    expect(await invoke("new", "./checkout.diagram.json")).toBe(1);
    expect(await invoke("render", "./checkout.diagram.json", "-o", "./checkout.diagram.json")).toBe(1);
    expect(await readFile(target, "utf8")).toBe(edited);
    expect(await invoke("render", "./checkout.diagram.json", "-o", "./result.svg")).toBe(0);
    expect(await readFile(join(folder, "result.svg"), "utf8")).toContain("<title>Checkout edited</title>");
  } finally {
    await rm(folder, {recursive:true,force:true});
  }
});
