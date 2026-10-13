/**
 * Test helper process: runs the real Bun annotate server in bundle mode over
 * the files named on the command line and prints its URL as one JSON line.
 * DOM tests start it as a child process because under happy-dom the global
 * `Response` is happy-dom's, which `Bun.serve` refuses.
 *
 *   bun packages/editor/testing/annotateBundleServer.ts <root> <file> <file>...
 *
 * The caller sets PLANNOTATOR_DATA_DIR (a temp directory) in the child's
 * environment and stops it with SIGTERM.
 */
import { startAnnotateServer } from "../../server/annotate";

const [root, ...files] = process.argv.slice(2);
if (!root || files.length < 2) {
  console.error("usage: annotateBundleServer.ts <root> <file> <file>...");
  process.exit(2);
}

const server = await startAnnotateServer({
  markdown: "",
  filePath: root,
  mode: "annotate-bundle",
  bundleFiles: files.map((path) => ({ path, renderAs: "markdown" as const })),
  htmlContent: "<html><body>Plannotator</body></html>",
});
console.log(JSON.stringify({ url: server.url }));

const stop = () => {
  server.stop();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
