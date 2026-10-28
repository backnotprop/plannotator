/**
 * Port helpers for the PLANNOTATOR_LIVE_PORT tests (both live proxy
 * transports, both annotate servers, the CLI). Every port comes from the OS,
 * and every busy port is a real listener the test starts and closes.
 */

import { connect, createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { closeServer, occupyConsecutivePorts } from "./ports";

export { closeServer, occupyConsecutivePorts };

/** A loopback port the OS just handed out and that nothing holds now. */
export async function reserveFreePort(): Promise<number> {
  const { start, servers } = await occupyConsecutivePorts(1);
  await closeServer(servers[0]!);
  return start;
}

/**
 * `count` consecutive loopback ports where the first `busy` are held by real
 * listeners and the rest are free. Call `release()` when done.
 */
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

/** Whether something accepts a TCP connection at host:port. */
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

/** Whether this process can bind 127.0.0.1:port now (nothing holds it). */
export function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/** A non-loopback IPv4 address of this machine, if it has one. */
export function nonLoopbackIPv4(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return null;
}

/**
 * A port just below 1024 that this user may not bind (EACCES), or null when there
 * is none to test with: running as root, or a system that lets every user
 * bind low ports (a lowered ip_unprivileged_port_start, some macOS setups).
 */
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
