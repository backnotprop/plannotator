/**
 * System's project setup (approval "system-inbox", item 2): what the person chose for one project's drawing.
 *
 *   <data dir>/system/<project key>/setup.json   written by the Inbox's setup dialog, read by the Inbox and `tick`
 *
 * `repos` are the extra repos only (the project's own repo comes from its folder's git remote), each written
 * `host/owner/name`. `docs` are doc site URLs. `agent` and `model` draw the drawing phase and every redraw after it
 * (one choice: redraws never ask again); `model` is in the agent's own form (`claude-opus-5-5` for Claude Code,
 * `anthropic/claude-opus-5-5` for Pi and OpenCode), null for the agent's own default. `thread_message` is the first
 * message of the drawing's Inbox thread, set once Draw it starts one (null until then).
 *
 * Browser-safe: the window checks what the person types with the same functions the server checks the save with.
 */

export const SYSTEM_SETUP_VERSION = 1;

/** The agents the Inbox can start for System (its launch agents), by their setup.json names. */
export type SystemSetupAgent = 'claude' | 'pi' | 'opencode';
export const SYSTEM_SETUP_AGENTS: readonly SystemSetupAgent[] = ['claude', 'pi', 'opencode'];
export const SYSTEM_AGENT_NAMES: Record<SystemSetupAgent, string> = { claude: 'Claude Code', pi: 'Pi', opencode: 'OpenCode' };

/** A launch agent's id (`GET /api/inbox/sessions` `launch.agents[].agent`) as setup.json names it; null for one System does not run. */
export function systemAgentOfLaunch(id: string): SystemSetupAgent | null {
  return id === 'claude-code' ? 'claude' : id === 'pi' || id === 'opencode' ? id : null;
}

/** The model System recommends for the drawing phase and redraws, through whichever agent the person has. */
export const SYSTEM_RECOMMENDED_MODEL = { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' } as const;

/**
 * The recommended model's id as the agent takes it: Claude Code a bare model id, Pi and OpenCode `provider/model`
 * (their `--model`), so setup.json's `model` is passed to the agent as it is.
 */
export function systemRecommendedModel(agent: SystemSetupAgent): string {
  return agent === 'claude' ? SYSTEM_RECOMMENDED_MODEL.id : `anthropic/${SYSTEM_RECOMMENDED_MODEL.id}`;
}

/** The models offered for an agent: the recommended one first, then the agent's own default (`id` null). */
export function systemAgentModels(agent: SystemSetupAgent): { id: string | null; name: string; recommended: boolean }[] {
  return [
    { id: systemRecommendedModel(agent), name: SYSTEM_RECOMMENDED_MODEL.name, recommended: true },
    { id: null, name: `${SYSTEM_AGENT_NAMES[agent]}'s default`, recommended: false },
  ];
}

/** The model to keep when the person picks another agent: the recommended one stays recommended, a default stays default. */
export function systemModelForAgent(model: string | null, from: SystemSetupAgent, to: SystemSetupAgent): string | null {
  return model === null ? null : model === systemRecommendedModel(from) ? systemRecommendedModel(to) : model;
}

export interface SystemSetup {
  v: 1;
  repos: string[];
  docs: string[];
  agent: SystemSetupAgent;
  model: string | null;
  thread_message: string | null;
}

/** One project the setup dialog offers: found on this Mac, with a git remote. */
export interface SystemSetupProject {
  id: string;
  key: string;
  /** The name the sidebar shows (the person's rename, or the folder's name). */
  name: string;
  root: string;
  /** The project's own repo, `host/owner/name`, from its folder's `origin`. */
  repo: string;
  /** What was chosen before for this project; null when it was never set up. */
  setup: SystemSetup | null;
}

/** `GET /api/inbox/system/setup`. */
export interface SystemSetupAnswer {
  projects: SystemSetupProject[];
}

/** `POST /api/inbox/system/setup`: the person's choices for one project. */
export interface SystemSetupInput {
  project_id: string;
  repos: string[];
  docs: string[];
  agent: SystemSetupAgent;
  model: string | null;
}

/** Far past any real setup: a guard on the request, not a limit a person meets. */
export const SYSTEM_SETUP_LIST_MAX = 100;
const ENTRY_MAX = 2048;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const HOST = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/** Where a link into a repo turns into a page in it: GitHub's /tree/main, /blob/…, /commit/…, /pull/…, Bitbucket's /src/…, GitLab's /-/…. */
const REPO_PAGE = new Set(['tree', 'blob', 'src', 'commit', 'pull', '-']);
/** Forges a person may type the host of without a repo after it (`github.com/owner` is not `owner/name`). */
const FORGE_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org']);

function repoFrom(host: string, path: string): string | null {
  const parts = path.split('/').filter((part) => part.length > 0);
  // A link into a repo names the repo before the page (on any host); the owner and name come first.
  const page = parts.findIndex((part, index) => index >= 2 && REPO_PAGE.has(part.toLowerCase()));
  const kept = page >= 0 ? parts.slice(0, page) : parts;
  const named = host.toLowerCase() === 'github.com' ? kept.slice(0, 2) : kept;
  // `.git` after the name (`owner/name.git`, `owner/name.git/`): the trailing slash is already gone.
  if (named.length > 0) named[named.length - 1] = named[named.length - 1]!.replace(/\.git$/i, '');
  if (named.length < 2) return null;
  if (!named.every((part) => SEGMENT.test(part) && part !== '.' && part !== '..')) return null;
  if (!HOST.test(host)) return null;
  return `${host.toLowerCase()}/${named.join('/')}`;
}

const REPO_ERROR = 'That isn’t a repo. Use owner/name or the repo’s URL.';

/**
 * A repo the person typed, as `host/owner/name`: `owner/name` (on `defaultHost`), `host/owner/name`, an https link
 * to the repo or a page in it, or an ssh remote (`git@host:owner/name.git`).
 */
export function parseSystemRepo(input: string, defaultHost = 'github.com'): Parsed<string> {
  const text = input.trim();
  if (!text) return { ok: false, error: 'Type a repo: owner/name, or its URL.' };
  if (text.length > ENTRY_MAX || /\s/.test(text)) return { ok: false, error: REPO_ERROR };
  let repo: string | null = null;
  const scp = /^[A-Za-z0-9_.-]+@([^:/]+):(.+)$/.exec(text);
  if (scp) repo = repoFrom(scp[1]!, scp[2]!);
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      if (url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'ssh:' || url.protocol === 'git:') repo = repoFrom(url.hostname, url.pathname);
    } catch {
      repo = null;
    }
  } else {
    const first = text.split('/', 1)[0]!;
    const host = first.toLowerCase();
    // A forge's host and one part (`github.com/owner`) names no repo.
    if (host === defaultHost.toLowerCase() || FORGE_HOSTS.has(host)) repo = repoFrom(first, text.slice(first.length));
    else repo = first.includes('.') && text.split('/').length >= 3 ? repoFrom(first, text.slice(first.length)) : repoFrom(defaultHost, text);
  }
  return repo ? { ok: true, value: repo } : { ok: false, error: REPO_ERROR };
}

const DOC_ERROR = 'That isn’t a web address. Paste a doc site’s URL, like docs.example.com.';

/** A doc site the person pasted, as a full https (or http) URL. A bare host gets `https://`. */
export function parseSystemDocSite(input: string): Parsed<string> {
  const text = input.trim();
  if (!text) return { ok: false, error: 'Paste a doc site’s URL.' };
  if (text.length > ENTRY_MAX || /\s/.test(text)) return { ok: false, error: DOC_ERROR };
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^:/]+:\d+(\/|$)/.test(text);
  let url: URL;
  try {
    url = new URL(hasScheme ? text : `https://${text}`);
  } catch {
    return { ok: false, error: DOC_ERROR };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: 'A doc site starts with https://.' };
  if (url.username || url.password) return { ok: false, error: 'Leave the sign-in out of the address.' };
  if (url.hostname !== 'localhost' && !HOST.test(url.hostname)) return { ok: false, error: DOC_ERROR };
  url.hash = '';
  return { ok: true, value: url.href };
}

/** A repo as the dialog shows it: without the host when it is the project's own host. */
export function systemRepoLabel(repo: string, ownHost: string | null): string {
  const slash = repo.indexOf('/');
  return ownHost && repo.slice(0, slash) === ownHost ? repo.slice(slash + 1) : repo;
}

/** A doc site as the dialog shows it: no scheme, no trailing slash. */
export function systemDocLabel(url: string): string {
  return url.replace(/^https:\/\//, '').replace(/\/$/, '');
}

/** The host of a `host/owner/name` repo. */
export function systemRepoHost(repo: string): string {
  return repo.slice(0, repo.indexOf('/'));
}

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** `list` with `entry` added at the end, unless it is there already (repos match without case) or is `own`. */
export function withSystemEntry(list: readonly string[], entry: string, own?: string): string[] {
  if ((own && sameRepo(own, entry)) || list.some((item) => sameRepo(item, entry))) return [...list];
  return [...list, entry];
}

/**
 * The server's check of a save: every repo and doc site parsed as the dialog parses them, duplicates and the
 * project's own repo dropped. The first entry that does not parse names its field.
 */
export function systemSetupFromInput(
  body: Record<string, unknown>,
  ownRepo: string,
): { ok: true; value: Pick<SystemSetup, 'repos' | 'docs' | 'agent' | 'model'> } | { ok: false; field: string; error: string } {
  const lists: Record<'repos' | 'docs', string[]> = { repos: [], docs: [] };
  for (const field of ['repos', 'docs'] as const) {
    const given = body[field] ?? [];
    if (!Array.isArray(given) || given.length > SYSTEM_SETUP_LIST_MAX || !given.every((item) => typeof item === 'string')) {
      return { ok: false, field, error: `${field}: a list of at most ${SYSTEM_SETUP_LIST_MAX} strings.` };
    }
    for (const item of given as string[]) {
      const parsed = field === 'repos' ? parseSystemRepo(item, systemRepoHost(ownRepo)) : parseSystemDocSite(item);
      if (parsed.ok === false) return { ok: false, field, error: `${field}: ${parsed.error}` };
      lists[field] = withSystemEntry(lists[field], parsed.value, field === 'repos' ? ownRepo : undefined);
    }
  }
  const agent = body.agent ?? 'claude';
  if (!SYSTEM_SETUP_AGENTS.includes(agent as SystemSetupAgent)) return { ok: false, field: 'agent', error: `agent: ${SYSTEM_SETUP_AGENTS.join(', ')}.` };
  const model = body.model === undefined ? systemRecommendedModel(agent as SystemSetupAgent) : body.model;
  if (model !== null && (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/.test(model))) {
    return { ok: false, field: 'model', error: 'model: a model id, or null for the agent\u2019s own default.' };
  }
  return { ok: true, value: { repos: lists.repos, docs: lists.docs, agent: agent as SystemSetupAgent, model: model as string | null } };
}

/** A setup.json read back; null when it is not a format 1 setup. */
export function parseSystemSetup(value: unknown): SystemSetup | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const strings = (list: unknown): list is string[] => Array.isArray(list) && list.every((item) => typeof item === 'string');
  if (v.v !== SYSTEM_SETUP_VERSION || !strings(v.repos) || !strings(v.docs)) return null;
  if (!SYSTEM_SETUP_AGENTS.includes(v.agent as SystemSetupAgent)) return null;
  if (v.thread_message !== null && typeof v.thread_message !== 'string') return null;
  if (v.model !== undefined && v.model !== null && typeof v.model !== 'string') return null;
  return { v: 1, repos: v.repos, docs: v.docs, agent: v.agent as SystemSetupAgent, model: (v.model as string | null | undefined) ?? null, thread_message: v.thread_message as string | null };
}
