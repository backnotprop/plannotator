import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { killAllBackgroundClis } from "./cli";
import { killAllDaemons } from "./daemon";

export type Sandbox = {
  home: string;
  cleanup(): void;
};

export function createSandbox(): Sandbox {
  const home = mkdtempSync(join(tmpdir(), "plannotator-e2e-home-"));
  return {
    home,
    cleanup() {
      killAllBackgroundClis();
      killAllDaemons();
      try {
        rmSync(home, { recursive: true, force: true });
      } catch {}
    },
  };
}

export async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();
    server.unref();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPort(new Error("Failed to allocate a free port."));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) {
          rejectPort(err);
          return;
        }
        resolvePort(port);
      });
    });
  });
}
