/**
 * A page's own link to the Inbox, as a loopback TCP proxy the verifier can cut (live verifier): `down()` closes every
 * connection the page holds, its open event stream included, and refuses new ones until `up()`. Chromium's emulated
 * offline (and Playwright's context offline) fail new requests but leave an open stream up, so a window that draws
 * records in place from its stream would never miss anything there.
 */
import { createConnection, createServer, type Server, type Socket } from 'node:net';

export class LinkProxy {
  private server: Server | null = null;
  private sockets = new Set<Socket>();
  private cut = false;
  port = 0;

  constructor(private readonly target: number) {}

  async start(): Promise<this> {
    this.server = createServer((client) => {
      if (this.cut) return void client.destroy();
      const upstream = createConnection({ host: '127.0.0.1', port: this.target });
      for (const s of [client, upstream]) {
        this.sockets.add(s);
        s.on('close', () => this.sockets.delete(s));
        s.on('error', () => {});
      }
      client.pipe(upstream);
      upstream.pipe(client);
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    });
    await new Promise<void>((done) => this.server!.listen(0, '127.0.0.1', done));
    this.port = (this.server.address() as { port: number }).port;
    return this;
  }

  down(): void {
    this.cut = true;
    for (const s of this.sockets) s.destroy();
  }

  up(): void {
    this.cut = false;
  }

  async stop(): Promise<void> {
    this.down();
    await new Promise<void>((done) => (this.server ? this.server.close(() => done()) : done()));
  }
}
