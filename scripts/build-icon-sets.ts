import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sniffImageContentType } from "../packages/shared/review-image";

interface SourceIcon {
  id: string;
  n: number;
  name: string;
  file: string;
  words?: string[];
  by?: string;
}

const [from, outArg] = process.argv.slice(2);
if (!from) {
  console.error("usage: bun scripts/build-icon-sets.ts <pack folder> [<out folder>]");
  process.exit(2);
}
const source = JSON.parse(readFileSync(join(from, "manifest.json"), "utf8")) as Record<string, unknown> & { id: string; icons: SourceIcon[] };
const out = resolve(outArg ?? join(import.meta.dir, "..", "packages/inbox/assets/icon-sets", source.id));
mkdirSync(out, { recursive: true });

const icons = [...source.icons].sort((a, b) => a.n - b.n);
const parts: Uint8Array[] = [];
let at = 0;
let type: string | null = null;
const listed = icons.map((icon, i) => {
  if (icon.n !== i + 1) throw new Error(`${source.id}: numbers must run 1..count (${icon.id} is #${icon.n})`);
  if (!/^[a-z0-9-]{1,80}$/.test(icon.id)) throw new Error(`${source.id}: bad id ${icon.id}`);
  const bytes = new Uint8Array(readFileSync(join(from, "icons", icon.file)));
  const sniffed = sniffImageContentType(bytes);
  if (!sniffed) throw new Error(`${source.id}: ${icon.file} is not an image`);
  if (type && sniffed !== type) throw new Error(`${source.id}: one type per set (${icon.file} is ${sniffed}, not ${type})`);
  type = sniffed;
  parts.push(bytes);
  const entry = { id: icon.id, n: icon.n, name: icon.name, ...(icon.words?.length ? { words: icon.words } : {}), ...(icon.by ? { by: icon.by } : {}), at, len: bytes.byteLength };
  at += bytes.byteLength;
  return entry;
});

const manifest = {
  v: 1,
  id: source.id,
  name: source.name,
  source: source.source,
  licence: source.licence,
  credit: source.credit,
  ...(source.pixelated ? { pixelated: true } : {}),
  ...(typeof source.size === "number" ? { size: source.size } : {}),
  ...(source.mono ? { mono: true } : {}),
  version: source.version,
  type,
  count: listed.length,
  icons: listed,
};
const bin = new Uint8Array(at);
let offset = 0;
for (const part of parts) {
  bin.set(part, offset);
  offset += part.byteLength;
}
writeFileSync(join(out, "icons.bin"), bin);
writeFileSync(
  join(out, "manifest.json"),
  `${JSON.stringify({ ...manifest, icons: [] }, null, 1).replace('"icons": []', `"icons": [\n${listed.map((icon) => `  ${JSON.stringify(icon)}`).join(",\n")}\n ]`)}\n`,
);
console.log(`${source.id}: ${listed.length} icons, ${at} bytes → ${out}`);
