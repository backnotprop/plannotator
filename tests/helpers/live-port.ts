import { connect, createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { closeServer, occupyConsecutivePorts } from "./ports";

export { closeServer, occupyConsecutivePorts };

export async function reserveFreePort(): Promise<number> {
  const { start, servers } = await occupyConsecutivePorts(1);
  await closeServer(servers[0]!);
  return start;
}

export async function partlyBusyRange(count: number, busy: number): Promise<{
  start: number;
  end: number;
  release: () => Promise<void>;
}> {
  const { start, servers } = await occupyConsecutivePorts(count);
  await Promise.all(servers.slice(busy).map(closeServer));
  return {
    start,
    end: start + count - 1,
    release: () => Promise.all(servers.map(closeServer)).then(() => {}),
  };
}

export function accepts(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (result: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

export function nonLoopbackIPv4(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return null;
}

export async function deniedLowPort(): Promise<number | null> {
  if (process.getuid?.() === 0) return null;
  for (const port of [1023, 1022, 1021]) {
    const code = await new Promise<string | null>((resolve) => {
      const server = createServer();
      server.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "unknown"));
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(null)));
    });
    if (code === "EACCES") return port;
    if (code === null) return null;
  }
  return null;
}
