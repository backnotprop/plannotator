/**
 * Writes `<page>.gz` next to a built page, for a page the CLI embeds
 * compressed (today `apps/hook/dist/shape.html`, about 13 MB built and 3 MB
 * gzipped; the Shapes server sends the gzip bytes as they are to a browser that
 * takes gzip, see packages/server/shape.ts).
 *
 *   bun scripts/gzip-page.ts <page>
 *
 * Level 9, and node's gzip header has no file name and a zero mtime, so the
 * same page always gives the same bytes.
 */
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
