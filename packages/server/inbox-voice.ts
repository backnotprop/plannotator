/**
 * Voice dictation (approval "inbox-voice", 2026-10-31): the window records a clip, posts a 24 kHz mono WAV here, and
 * gets the words back. This server does the transcribing, so a token or key never reaches a page, and a phone over the
 * tailnet posts to its Inbox like any page. Off by default: off, no route starts a `codex`.
 *
 * Two engines. `codex`: a short-lived `codex app-server`, started the way Ask AI starts one
 * (`CodexAppServerProcess`, `askAiChildEnv`, `codexAskAiConfigArgs`), is asked for the ChatGPT login's token with
 * `getAuthStatus { includeToken: true }`; the clip goes to ChatGPT's private transcription endpoint, and Codex stops.
 * `api`: OpenAI's public `/v1/audio/transcriptions` with the person's key.
 *
 * What must stay true here:
 *  - An honest User-Agent, no browser headers. A 403 or a challenge page is an answer, never something to get around:
 *    no change of headers and no automatic retry. The one automatic retry is one token refresh on a 401. Only a
 *    person's press retries anything else.
 *  - A token, key or clip is never logged, written to disk (the key's own file aside) or returned. Failures are fixed
 *    codes (`InboxVoiceFailure`), never upstream text.
 *  - The key's file is private (0600), set on this computer or by its owner over the tailnet's HTTPS; a page sees the
 *    last 4 at most.
 *  - Audio is held in memory for the length of the request.
 *  - `account/read` gives the sign-in type and plan, never a token: it is what Settings, the dimmed mic and the
 *    announcement's audience read. Its email field is dropped here.
 *
 * Linked machines: the Inbox that serves the window transcribes. These routes are in no door table, so a forward
 * (`/api/inbox/m/<machine>/voice/…`) answers 404 and audio never leaves for another machine.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CodexAppServerProcess } from "@plannotator/ai/providers/codex-app-server";
import {
  INBOX_VOICE_MAX_CLIP_BYTES,
  type InboxVoiceEngine,
  type InboxVoiceFailure,
  type InboxVoiceKeyState,
  type InboxVoiceSettings,
  type InboxVoiceStatus,
} from "@plannotator/core/inbox-types";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { loadConfig, saveConfig } from "@plannotator/shared/config";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { codexHome, type AgentEnvironment } from "./inbox-agents";
import { codexCliCandidates } from "./inbox-codex-wake";

/** ChatGPT's own transcription endpoint: undocumented. The route the owner chose knowing that. */
export const VOICE_CHATGPT_URL = "https://chatgpt.com/backend-api/transcribe";
/** OpenAI's public one. */
export const VOICE_OPENAI_URL = "https://api.openai.com/v1/audio/transcriptions";
export const VOICE_OPENAI_MODEL = "gpt-transcribe";

/** The private file of a key pasted in Settings, under the data dir. */
export const VOICE_KEY_FILE = join("inbox", "voice-key");

/** One clip's trip upstream: a 2:00 clip is about 5.8 MB. */
const UPSTREAM_MS = 120_000;
/** Codex's start and each of its answers. */
const CODEX_MS = 10_000;
/** How long Settings and the mic share one `account/read`. */
const STATUS_TTL_MS = 30_000;
/** Voice asks Codex for an account and a token, a few KB each: a longer line is a broken `codex`. */
const CODEX_LINE_MAX = 1024 * 1024;

/** The worklet that hands the window its samples. Served from this origin: the window's CSP refuses `blob:` and `data:` here. */
export const VOICE_WORKLET_SOURCE = `class PlannotatorVoiceTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.at = 0;
    this.port.onmessage = () => {
      this.port.postMessage(this.buffer.slice(0, this.at));
      this.at = 0;
      this.port.postMessage("flushed");
    };
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.buffer[this.at++] = channel[i];
        if (this.at === this.buffer.length) {
          this.port.postMessage(this.buffer.slice(0));
          this.at = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("plannotator-voice-tap", PlannotatorVoiceTap);
`;

type Clip = Uint8Array<ArrayBuffer>;

type Outcome = { ok: true; text: string } | { ok: false; code: InboxVoiceFailure; reason?: InboxVoiceStatus["state"] };

interface CodexAuth {
  state: InboxVoiceStatus["state"];
  token: string | null;
}

export interface InboxVoiceOptions {
  dataDir: string;
  environment: AgentEnvironment;
  version: string;
  serverSession: string;
  /** Someone used an Inbox here before: the announcement is due, not marked shown. */
  usedBefore: boolean;
  /** A release build: only those decide the announcement, as the list intro's rule. */
  decidesIntro: boolean;
  /** The name a page over the tailnet shows for this computer. */
  computerName: () => string;
  /** Another one-time dialog waits to be claimed: the announcement never goes before it. */
  otherDialogDue: () => boolean;
  json: (body: unknown, status?: number) => Response;
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  /** Tests: fake endpoints and where to look for Codex besides PATH. */
  chatgptUrl?: string;
  openaiUrl?: string;
  extraClis?: readonly string[];
}

export interface InboxVoice {
  /** `guest`: a tailnet login other than the owner's, for whom voice is off and the key unsaid. */
  settings(via: "local" | "tailnet", guest?: boolean): InboxVoiceSettings;
  /** `validateOnly`: check `input` and write nothing. */
  save(input: unknown, validateOnly?: boolean): void;
  route(req: Request, url: URL, via: "local" | "tailnet"): Promise<Response | null>;
  stop(): void;
}

function statusFromAccount(result: Record<string, unknown>): InboxVoiceStatus {
  const account = result.account as { type?: unknown; planType?: unknown } | null | undefined;
  if (!account) return { state: "signedout", plan: null };
  if (account.type === "chatgpt") return { state: "ready", plan: typeof account.planType === "string" && account.planType ? account.planType : null };
  if (account.type === "apiKey") return { state: "apikey", plan: null };
  return { state: "other", plan: null };
}

function authFromStatus(result: Record<string, unknown>): CodexAuth {
  const method = typeof result.authMethod === "string" ? result.authMethod.toLowerCase() : "";
  const token = typeof result.authToken === "string" && result.authToken ? result.authToken : null;
  if (method.startsWith("chatgpt")) return { state: token ? "ready" : "signedout", token };
  if (method === "apikey") return { state: "apikey", token: null };
  return { state: method ? "other" : "signedout", token: null };
}

const isWav = (clip: Clip) =>
  clip.length > 44 && String.fromCharCode(...clip.subarray(0, 4)) === "RIFF" && String.fromCharCode(...clip.subarray(8, 12)) === "WAVE";

/** The request's body, or null past the limit (read no further than that). */
async function readClip(req: Request): Promise<Clip | null> {
  if (Number(req.headers.get("content-length") ?? 0) > INBOX_VOICE_MAX_CLIP_BYTES) return null;
  const clip = new Uint8Array(new ArrayBuffer(INBOX_VOICE_MAX_CLIP_BYTES));
  let at = 0;
  if (req.body) {
    for await (const chunk of req.body) {
      if (at + chunk.length > clip.length) return null;
      clip.set(chunk, at);
      at += chunk.length;
    }
  }
  return clip.subarray(0, at);
}

export function createInboxVoice(options: InboxVoiceOptions): InboxVoice {
  const { dataDir, environment, json } = options;
  const chatgptUrl = options.chatgptUrl ?? VOICE_CHATGPT_URL;
  const openaiUrl = options.openaiUrl ?? VOICE_OPENAI_URL;
  const userAgent = `Plannotator/${options.version} (voice dictation; https://plannotator.ai)`;
  const keyPath = join(dataDir, VOICE_KEY_FILE);
  /** Codex's config is read from the same home it runs with, never a home the Inbox was not given. */
  const codexEnv = { ...environment.env, CODEX_HOME: codexHome(environment) };
  const running = new Set<CodexAppServerProcess>();

  // ── Settings ──
  const saved = () => {
    const value = loadConfig().inboxVoice;
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  };
  const isOn = () => saved().on === true;
  const engine = (): InboxVoiceEngine => (saved().engine === "api" ? "api" : "codex");

  const savedKey = (): string | null => {
    try {
      return readFileSync(keyPath, "utf8").trim() || null;
    } catch {
      return null;
    }
  };
  const envKey = (): string | null => environment.env.OPENAI_API_KEY?.trim() || null;
  /** A key pasted here wins: it is what the page offers to replace or remove. */
  const apiKey = () => savedKey() ?? envKey();
  const keyState = (): InboxVoiceKeyState => {
    const key = savedKey();
    if (key) return { source: "saved", last4: key.slice(-4) };
    return { source: envKey() ? "env" : null, last4: null };
  };
  const writeKey = (key: string) => {
    mkdirSync(join(dataDir, "inbox"), { recursive: true, mode: 0o700 });
    const temp = `${keyPath}.${process.pid}.tmp`;
    writeFileSync(temp, `${key}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, keyPath);
  };

  // ── Codex ──
  /** One `codex app-server` for one job, always stopped. `signal`: the page gave up, so Codex stops at once. */
  const withCodex = async <T>(job: (codex: CodexAppServerProcess) => Promise<T>, signal?: AbortSignal): Promise<T | "missing"> => {
    const path = codexCliCandidates(environment, options.extraClis)[0];
    if (!path) return "missing";
    const codex = new CodexAppServerProcess(CODEX_LINE_MAX);
    const kill = () => codex.kill();
    running.add(codex);
    signal?.addEventListener("abort", kill, { once: true });
    try {
      await codex.start(path, dataDir, CODEX_MS, codexEnv);
      return await job(codex);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    } finally {
      signal?.removeEventListener("abort", kill);
      running.delete(codex);
      codex.kill();
    }
  };

  const readStatus = async (): Promise<InboxVoiceStatus> => {
    try {
      const status = await withCodex(async (codex) => statusFromAccount(await codex.sendAndWait({ method: "account/read", params: {} }, CODEX_MS)));
      return status === "missing" ? { state: "missing", plan: null } : status;
    } catch {
      return { state: "unknown", plan: null };
    }
  };
  let statusAnswer: { at: number; status: InboxVoiceStatus } | null = null;
  let statusRead: Promise<InboxVoiceStatus> | null = null;
  const codexStatus = (fresh: boolean): Promise<InboxVoiceStatus> => {
    if (!fresh && statusAnswer && Date.now() - statusAnswer.at < STATUS_TTL_MS) return Promise.resolve(statusAnswer.status);
    statusRead ??= readStatus()
      .then((status) => {
        statusAnswer = { at: Date.now(), status };
        return status;
      })
      .finally(() => {
        statusRead = null;
      });
    return statusRead;
  };

  // ── The announcement ──
  if (options.decidesIntro && loadConfig().inboxVoiceIntro === undefined) {
    const at = new Date().toISOString();
    saveConfig({ inboxVoiceIntro: options.usedBefore ? { dueAt: at } : { shownAt: at } });
  }
  /** The one check of this Inbox start: null until it ran. A computer that failed it waits for the next start. */
  let introAudience: boolean | null = null;
  let introCheck: Promise<boolean> | null = null;
  const checkIntroAudience = (): Promise<boolean> => {
    introCheck ??= (async () => {
      // No `codex`, nothing started.
      if (codexCliCandidates(environment, options.extraClis).length === 0) return false;
      return (await codexStatus(false)).state === "ready";
    })().then((ready) => {
      introAudience = ready;
      return ready;
    });
    return introCheck;
  };
  const introDue = () => {
    const intro = loadConfig().inboxVoiceIntro;
    return typeof intro?.dueAt === "string" && intro.dueAt !== "" && !intro.shownAt && !isOn();
  };
  /** Only the first claim ever gets true. No await between the last read and the write, so two tabs cannot both win. */
  const claimIntro = async (via: "local" | "tailnet"): Promise<boolean> => {
    if (via !== "local" || !introDue() || options.otherDialogDue()) return false;
    if (!(await checkIntroAudience())) return false;
    if (!introDue() || options.otherDialogDue()) return false;
    const at = new Date().toISOString();
    saveConfig({ inboxVoiceIntro: { ...loadConfig().inboxVoiceIntro, shownAt: at } });
    // Not written (a read-only data dir): showing it anyway would show it on every load.
    return loadConfig().inboxVoiceIntro?.shownAt === at;
  };

  // ── Transcribing ──
  const post = async (url: string, secret: string, form: FormData, signal: AbortSignal): Promise<Response | Outcome> => {
    try {
      return await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "User-Agent": userAgent },
        body: form,
        // A redirect would carry the secret somewhere this code did not name.
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(UPSTREAM_MS)]),
      });
    } catch {
      return { ok: false, code: "voice_unreachable" };
    }
  };
  const words = async (response: Response): Promise<Outcome> => {
    const payload = (await response.json().catch(() => null)) as { text?: unknown } | null;
    if (payload === null) return { ok: false, code: "voice_refused" };
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    return text ? { ok: true, text } : { ok: false, code: "voice_empty" };
  };
  const clipForm = (clip: Clip) => {
    const form = new FormData();
    form.append("file", new Blob([clip], { type: "audio/wav" }), "voice.wav");
    return form;
  };

  const viaCodex = async (clip: Clip, signal: AbortSignal): Promise<Outcome> => {
    const answer = await withCodex(async (codex): Promise<Outcome> => {
      const auth = async (refreshToken: boolean) => authFromStatus(await codex.sendAndWait({ method: "getAuthStatus", params: { includeToken: true, refreshToken } }, CODEX_MS));
      const first = await auth(false);
      if (!first.token) return { ok: false, code: "voice_not_ready", reason: first.state };
      let sent = await post(chatgptUrl, first.token, clipForm(clip), signal);
      // The one automatic retry: Codex refreshes the login, and the same clip goes once more.
      if (sent instanceof Response && sent.status === 401 && !sent.headers.has("cf-mitigated")) {
        const second = await auth(true);
        if (second.token) sent = await post(chatgptUrl, second.token, clipForm(clip), signal);
      }
      if (!(sent instanceof Response)) return sent;
      // Cloudflare's mark, whatever the status: stop here.
      if (sent.headers.has("cf-mitigated")) return { ok: false, code: "voice_refused" };
      if (sent.status === 401) return { ok: false, code: "voice_expired" };
      if (sent.status >= 500) return { ok: false, code: "voice_unreachable" };
      if (!sent.ok || !(sent.headers.get("content-type") ?? "").includes("json")) return { ok: false, code: "voice_refused" };
      return words(sent);
    }, signal).catch((): Outcome => ({ ok: false, code: "voice_codex_failed" }));
    return answer === "missing" ? { ok: false, code: "voice_not_ready", reason: "missing" } : answer;
  };

  const viaKey = async (clip: Clip, signal: AbortSignal): Promise<Outcome> => {
    const key = apiKey();
    if (!key) return { ok: false, code: "voice_not_ready", reason: "nokey" };
    const form = clipForm(clip);
    form.append("model", VOICE_OPENAI_MODEL);
    const sent = await post(openaiUrl, key, form, signal);
    if (!(sent instanceof Response)) return sent;
    if (sent.status === 401 || sent.status === 403) return { ok: false, code: "voice_key_refused" };
    if (sent.status >= 500) return { ok: false, code: "voice_unreachable" };
    return sent.ok ? words(sent) : { ok: false, code: "voice_refused" };
  };

  const FAILURE_STATUS: Record<InboxVoiceFailure, number> = {
    voice_off: 409,
    voice_not_ready: 409,
    voice_bad_clip: 400,
    voice_expired: 502,
    voice_refused: 502,
    voice_key_refused: 502,
    voice_unreachable: 502,
    voice_codex_failed: 502,
    voice_empty: 502,
  };
  const failure = (code: InboxVoiceFailure, reason?: InboxVoiceStatus["state"]) =>
    json({ error: "Voice did not transcribe this clip.", code, engine: engine(), ...(reason ? { reason } : {}) }, FAILURE_STATUS[code]);

  return {
    settings: (via, guest = false) => {
      const value = saved();
      return {
        on: !guest && value.on === true,
        phones_only: value.phonesOnly === true,
        engine: engine(),
        key: guest ? { source: null, last4: null } : keyState(),
        computer: via === "tailnet" ? options.computerName() : null,
        intro_due: !guest && introDue() && introAudience !== false,
        guest,
      };
    },

    save: (input, validateOnly = false) => {
      const body = input as { on?: unknown; phones_only?: unknown; engine?: unknown } | null;
      const valid =
        !!body &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        (body.on === undefined || typeof body.on === "boolean") &&
        (body.phones_only === undefined || typeof body.phones_only === "boolean") &&
        (body.engine === undefined || body.engine === "codex" || body.engine === "api") &&
        Object.keys(body).every((key) => key === "on" || key === "phones_only" || key === "engine");
      if (!valid) throw new InboxError("validation_error", "voice: { on?: boolean, phones_only?: boolean, engine?: 'codex' | 'api' }.", { field: "voice" });
      if (validateOnly) return;
      const value = saved();
      const written = saveConfig({
        inboxVoice: {
          ...value,
          ...(body.on === undefined ? {} : { on: body.on as boolean }),
          ...(body.phones_only === undefined ? {} : { phonesOnly: body.phones_only as boolean }),
          ...(body.engine === undefined ? {} : { engine: body.engine as InboxVoiceEngine }),
        },
      });
      if (!written) throw new InboxError("config_not_saved", "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.");
      // Turned on (the dialog, or Settings first): nothing left to announce.
      const intro = loadConfig().inboxVoiceIntro;
      if (body.on === true && intro && !intro.shownAt) saveConfig({ inboxVoiceIntro: { ...intro, shownAt: new Date().toISOString() } });
    },

    route: async (req, url, via) => {
      const path = url.pathname;
      if (path === "/api/inbox/voice/worklet.js") {
        if (req.method !== "GET") return json({ error: "Use GET." }, 405);
        return new Response(VOICE_WORKLET_SOURCE, { headers: { "Content-Type": "text/javascript; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" } });
      }
      if (path === "/api/inbox/voice/status") {
        if (req.method !== "GET") return json({ error: "Use GET." }, 405);
        if (!isOn()) return json({ state: "off", plan: null } satisfies InboxVoiceStatus);
        if (engine() === "api") return json({ state: apiKey() ? "ready" : "nokey", plan: null } satisfies InboxVoiceStatus);
        return json(await codexStatus(url.searchParams.get("fresh") === "1"));
      }
      if (path === "/api/inbox/voice/intro") {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        const body = await options.readBody(req);
        if (checkServerSession(body, options.serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        return json({ show: await claimIntro(via) });
      }
      if (path === "/api/inbox/voice/key") {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        // Over the tailnet a key travels only what `tailscale serve` took in over TLS (it says so in this header,
        // and sets nothing on a plain-http mapping). The server's gate already kept every login but the owner's out.
        if (via !== "local" && req.headers.get("x-forwarded-proto") !== "https") {
          return json({ error: "An API key is accepted only over HTTPS.", code: "https_required" }, 403);
        }
        const body = await options.readBody(req);
        if (checkServerSession(body, options.serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        if (body.key === null) rmSync(keyPath, { force: true });
        else if (typeof body.key === "string" && /^[\x21-\x7e]{8,512}$/.test(body.key.trim())) writeKey(body.key.trim());
        else throw new InboxError("validation_error", "key: that doesn't look like an API key.", { field: "key" });
        return json({ key: keyState() });
      }
      if (path === "/api/inbox/voice/transcribe") {
        if (req.method !== "POST") return json({ error: "Use POST." }, 405);
        if (checkServerSession({ serverSession: url.searchParams.get("serverSession") ?? undefined }, options.serverSession) === "mismatch") {
          return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
        }
        if (!isOn()) return failure("voice_off");
        if (!(req.headers.get("content-type") ?? "").startsWith("audio/wav")) return failure("voice_bad_clip");
        const clip = await readClip(req);
        if (!clip || !isWav(clip)) return failure("voice_bad_clip");
        const outcome = await (engine() === "api" ? viaKey : viaCodex)(clip, req.signal);
        return outcome.ok ? json({ text: outcome.text }) : failure(outcome.code, outcome.reason);
      }
      return null;
    },

    stop: () => {
      for (const codex of running) codex.kill(true);
      running.clear();
    },
  };
}
