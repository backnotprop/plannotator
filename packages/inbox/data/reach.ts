/** "Over your tailnet" (packages/server/inbox-tailscale.ts): the switch, the address or why not, and who may open it. */
export interface TailscaleSettings {
  on: boolean;
  /** What decides it: `flag` (this run's `--tailscale`), `env` (PLANNOTATOR_INBOX_TAILSCALE), `config` (this switch), `default`. */
  source: 'flag' | 'env' | 'config' | 'default';
  /** PLANNOTATOR_INBOX_TAILSCALE when set: the switch is locked. */
  env: boolean | null;
  url: string | null;
  error: string | null;
  owner: string | null;
  allowed: string[];
  /** Serve routes pointing at the Inbox's own port (a hand-made mapping): each exposes the whole Inbox. Absent from an older Inbox. */
  exposed?: { https_port: number | null; target: string | null }[];
}

export interface CloudflareAccessSettings {
  on: boolean;
  configured: boolean;
  url: string | null;
  sessionsUrl?: string | null;
  error: string | null;
  port: number | null;
  allowed: string[];
  tunnel: { state: 'starting' | 'connected' | 'retrying' | 'missing' | 'stopped'; pid: number | null; connections: number; restarts: number; error: string | null } | null;
}
