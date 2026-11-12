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
