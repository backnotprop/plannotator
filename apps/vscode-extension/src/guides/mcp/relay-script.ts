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
