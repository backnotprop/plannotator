import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type Json = Record<string, any>;

export const relayDir = resolve(import.meta.dir, "..");
export const wrangler = join(relayDir, "node_modules", ".bin", "wrangler");

export const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
export const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export async function until<T>(read: () => T | Promise<T>, ok: (value: T) => boolean, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await sleep(100);
  }
}

export function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

export async function helloOf(relayUrl: string, mailboxId: string, secret: string): Promise<Json> {
  const socket = new WebSocket(`${relayUrl.replace(/^http/, "ws")}/v1/mailboxes/${mailboxId}/socket`, { headers: { Authorization: `Bearer ${secret}` } } as unknown as string[]);
  try {
    return await new Promise<Json>((done, fail) => {
      socket.onmessage = (event) => done(JSON.parse(String(event.data)));
      socket.onerror = () => fail(new Error("the socket failed"));
      setTimeout(() => fail(new Error("no hello")), 10_000);
    });
  } finally {
    socket.close();
  }
}

export interface Relay {
  url: string;
  persist: string;
  log: () => string;
  stop: () => Promise<void>;
}

export async function startRelay(name: string, vars: Record<string, string>, options: { keep?: boolean } = {}): Promise<Relay> {
  const port = freePort();
  const persist = join(relayDir, ".wrangler", `proof-${name}`);
  if (!options.keep) rmSync(persist, { recursive: true, force: true });
  mkdirSync(persist, { recursive: true });
  const envFile = join(persist, "relay.env");
  writeFileSync(envFile, Object.entries(vars).map(([k, v]) => (/^[\w.:/+=-]*$/.test(v) ? `${k}=${v}\n` : `${k}='${v}'\n`)).join(""), { mode: 0o600 });
  let output = "";
  const child = Bun.spawn(
    [wrangler, "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(freePort()), "--persist-to", persist, "--env-file", envFile, "--show-interactive-dev-session=false"],
    { cwd: relayDir, stdout: "pipe", stderr: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" } },
  );
  for (const stream of [child.stdout, child.stderr]) {
    void (async () => {
      for await (const chunk of stream) output += new TextDecoder().decode(chunk);
    })();
  }
  const url = `http://127.0.0.1:${port}`;
  await until(
    () => fetch(`${url}/v1/nothing`).then((r) => r.status).catch(() => 0),
    (status) => status === 404,
    `wrangler dev for ${name}\n${output}`,
    60_000,
  );
  return {
    url,
    persist,
    log: () => output,
    stop: async () => {
      child.kill();
      rmSync(envFile, { force: true });
      writeFileSync(join(persist, "wrangler.log"), output);
      await child.exited;
    },
  };
}

export function mailboxFiles(relay: Relay): string[] {
  const dir = join(relay.persist, "v3", "do", "plannotator-relay-Mailbox");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite").map((f) => join(dir, f)) : [];
}

export function readMailbox(relay: Relay, mailboxId: string): { mailbox: Json | null; devices: Json[] } {
  for (const file of mailboxFiles(relay)) {
    const db = new Database(file, { readonly: true });
    try {
      const name = db.query("SELECT name FROM __miniflare_do_name").get() as { name: string } | null;
      if (name?.name !== mailboxId) continue;
      const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
      if (!tables.includes("mailbox")) return { mailbox: null, devices: [] };
      return { mailbox: db.query("SELECT * FROM mailbox").get() as Json, devices: db.query("SELECT * FROM devices ORDER BY id").all() as Json[] };
    } finally {
      db.close();
    }
  }
  return { mailbox: null, devices: [] };
}

export function dumpMailbox(relay: Relay, mailboxId: string): Json {
  for (const file of mailboxFiles(relay)) {
    const db = new Database(file, { readonly: true });
    try {
      const name = db.query("SELECT name FROM __miniflare_do_name").get() as { name: string } | null;
      if (name?.name !== mailboxId) continue;
      const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite%'").all() as { name: string }[]).map((t) => t.name);
      return Object.fromEntries(tables.map((t) => [t, db.query(`SELECT * FROM ${t}`).all()]));
    } finally {
      db.close();
    }
  }
  return {};
}

export function storageBytes(relay: Relay): Buffer {
  const dir = join(relay.persist, "v3", "do", "plannotator-relay-Mailbox");
  return Buffer.concat(readdirSync(dir).map((f) => readFileSync(join(dir, f))));
}

export function holds(bytes: Buffer, text: string): boolean {
  return bytes.includes(Buffer.from(text, "utf8")) || bytes.includes(Buffer.from(text, "utf16le"));
}
