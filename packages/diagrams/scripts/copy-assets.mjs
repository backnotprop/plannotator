import { copyFile } from "node:fs/promises";
const root = new URL("../", import.meta.url);
for (const name of ["assets.js", "regular-face.js", "medium-face.js", "semibold-face.js", "bold-face.js"]) {
  await copyFile(new URL("fonts/" + name, root), new URL("dist/" + name, root));
}
await copyFile(new URL("scripts/worker.js", root), new URL("dist/worker.js", root));
