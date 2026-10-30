/**
 * Release (build job): the sha256 of every embedded page as the CLI serves
 * it, for scripts/smoke-pages.mjs, in `sha256sum` format.
 *
 * usage: bun scripts/page-digests.ts <file>...
 *
 * A packed page (build/pack-app.ts: the plan and review apps) is served as
 * the page plus one file per packed chunk, so it prints its page under its
 * own name and each packed file under the file's name; any other file (the
 * Inbox pages, the diagram engine) prints whole.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { openPackedApp, PACKED_ASSETS_MARKER } from "../packages/shared/packed-app";

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

for (const file of process.argv.slice(2)) {
  const bytes = readFileSync(file);
  const text = bytes.toString("utf8");
  const markerAt = text.indexOf(PACKED_ASSETS_MARKER);
  if (markerAt < 0) {
    console.log(`${sha256(bytes)}  ${file}`);
    continue;
  }
  const app = openPackedApp(text);
  console.log(`${sha256(app.html)}  ${basename(file)}`);
  const indexAt = markerAt + PACKED_ASSETS_MARKER.length;
  const index = JSON.parse(text.slice(indexAt, text.indexOf("\n", indexAt))) as Record<string, unknown>;
  for (const path of Object.keys(index)) {
    const answer = await app.answer(path, "GET", null, false);
    if (answer.status !== 200) throw new Error(`${file}: ${path} answers ${answer.status}`);
    console.log(`${sha256(answer.body)}  ${path.slice(1)}`);
  }
}
