import { copyFile, readFile, writeFile } from "node:fs/promises";
const root = new URL("../", import.meta.url);
for (const name of ["assets.js", "regular-face.js", "medium-face.js", "semibold-face.js", "bold-face.js"]) {
  await copyFile(new URL("fonts/" + name, root), new URL("dist/" + name, root));
}
await copyFile(new URL("scripts/worker.js", root), new URL("dist/worker.js", root));

// Hosts that ship a single compiled page can carry the same notices as the npm tarball.
const notices = await Promise.all(["LICENSE", "fonts/OFL.txt"].map(name => readFile(new URL(name, root), "utf8")));
await writeFile(new URL("dist/notices.js", root), "export default " + JSON.stringify(notices.join("\n")) + ";\n");
await writeFile(new URL("dist/notices.d.ts", root), "declare const notices: string;\nexport default notices;\n");
