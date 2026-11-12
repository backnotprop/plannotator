import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const page = process.argv[2];
if (!page) {
  process.stderr.write("usage: bun scripts/gzip-page.ts <page>\n");
  process.exit(2);
}
const html = readFileSync(page);
const gz = gzipSync(html, { level: 9 });
writeFileSync(`${page}.gz`, gz);
process.stdout.write(`${page}.gz: ${gz.length} bytes (${html.length} built)\n`);
