import * as http from "http";

export function createIpcServer(
  onUrl: (url: string) => void,
  preferredPort?: number,
): Promise<{ server: http.Server; port: number }> {
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const parsed = new globalThis.URL(req.url!, "http://localhost");
    const targetUrl = parsed.searchParams.get("url");

    if (req.method === "GET" && parsed.pathname === "/open" && targetUrl) {
      onUrl(targetUrl);
      res.writeHead(200);
      res.end("ok");
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  };

  function listen(port: number): Promise<{ server: http.Server; port: number }> {
    return new Promise((resolve, reject) => {
      const server = http.createServer(handler);
      server.listen(port, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          resolve({ server, port: addr.port });
        } else {
          reject(new Error("Failed to get server address"));
        }
      });
      server.on("error", reject);
    });
  }

  if (preferredPort) {
    return listen(preferredPort).catch(() => listen(0));
  }
  return listen(0);
}
