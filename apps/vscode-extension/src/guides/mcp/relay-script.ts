/**
 * `dist/guide-mcp.cjs`: the stdio MCP server the agent starts for a guide run
 * (SPEC 4.4). It holds no state. It connects to the extension's local pipe,
 * proves its session with the token from its environment, and then copies
 * bytes both ways: the agent's MCP client talks to the extension.
 *
 * Runs under VS Code's own runtime (`ELECTRON_RUN_AS_NODE=1`), so it needs no
 * Node on PATH. Keep it dependency-free: it is bundled on its own.
 */

import { connect } from "node:net";

const SOCKET_ENV = "PLANNOTATOR_GUIDE_MCP_SOCKET";
const TOKEN_ENV = "PLANNOTATOR_GUIDE_MCP_TOKEN";
const HELLO = "plannotator-guide-mcp/1";

function main(): void {
  const socketPath = process.env[SOCKET_ENV];
  const token = process.env[TOKEN_ENV];
  delete process.env[TOKEN_ENV];
  if (!socketPath || !token) {
    process.stderr.write("plannotator guide builder: started without its session; the VS Code extension starts it.\n");
    process.exit(2);
  }
  const socket = connect(socketPath);
  socket.on("connect", () => {
    socket.write(`${JSON.stringify({ hello: HELLO, token })}\n`);
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
  });
  socket.on("error", (err) => {
    process.stderr.write(`plannotator guide builder: cannot reach VS Code (${err.message}).\n`);
    process.exit(1);
  });
  socket.on("close", () => process.exit(0));
  process.stdin.on("end", () => socket.end());
}

main();
