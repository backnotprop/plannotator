import { pageServerSession } from '../api';
import { inboxUrl } from '../inboxUrl';

export type CloudflareStepId = 'account' | 'tunnel' | 'gate' | 'address' | 'checks';

export interface CloudflareView {
  configured: boolean;
  on: boolean;
  host: string | null;
  session_host: string | null;
  allowed: string[];
  url: string | null;
  sessions_url: string | null;
  error: string | null;
  tunnel: { state: 'starting' | 'connected' | 'retrying' | 'missing' | 'stopped'; pid: number | null; connections: number; restarts: number; error: string | null } | null;
  cloudflared: { found: boolean; install: string };
  job: {
    running: boolean;
    steps: { id: CloudflareStepId; state: 'pending' | 'running' | 'done' | 'failed' }[];
    host: string | null;
    failed: { step: CloudflareStepId; message: string; leftover: string[] } | null;
  } | null;
}

export interface CloudflareZone {
  name: string;
  account: string | null;
}

export class CloudflareRefusal extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

async function answer<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as (T & { error?: string; code?: string }) | null;
  if (!response.ok) throw new CloudflareRefusal(body?.error ?? `HTTP ${response.status}`, body?.code ?? 'failed');
  return body as T;
}

export async function readCloudflare(): Promise<CloudflareView> {
  return answer<CloudflareView>(await fetch(inboxUrl('/cloudflare-access'), { headers: { Accept: 'application/json' } }));
}

export async function postCloudflare<T = CloudflareView>(action: 'zones' | 'setup' | 'switch' | 'remove' | 'dismiss', body: Record<string, unknown>): Promise<T> {
  const response = await fetch(inboxUrl(`/cloudflare-access/${action}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...body, serverSession: pageServerSession() }),
  });
  return answer<T>(response);
}
