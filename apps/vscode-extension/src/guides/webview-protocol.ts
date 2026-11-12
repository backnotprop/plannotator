export interface HomeViewState {
  mode: "home";
  repo: { name: string; branch: string; host: string } | null;
  defaults: { agent: string; model: string; effort: string };
  ghNote: string | null;
  cards: {
    pr: { open: number; waiting: number; current: { number: number; title: string } | null } | null;
    local: { files: number; additions: number; deletions: number; baseLabel: string } | null;
  };
  recent: Array<{
    kind: "guide" | "draft";
    id: string;
    title: string;
    sub: string;
    progress: { reviewed: number; total: number } | null;
    note: string | null;
    warn: boolean;
    when: string;
  }>;
  waiting: Array<{ url: string; number: number; title: string; sub: string; inThisRepo: boolean }>;
  notes: string[];
}

export interface ActivityRow {
  id: number;
  at: string;
  kind: "message" | "tool" | "builder" | "plan" | "permission" | "info" | "error";
  title: string;
  detail?: string;
  status?: string;
  isError?: boolean;
  locations?: Array<{ path: string; line?: number }>;
}

export interface GeneratingViewState {
  mode: "generating";
  id: string;
  status: "starting" | "running" | "finishing" | "finished" | "stopped" | "failed";
  statusMessage: string | null;
  kicker: string;
  title: string;
  sub: string;
  agent: string;
  modelEffort: string;
  startedAt: number;
  endedAt: number | null;
  cost: string | null;
  activity: ActivityRow[];
  chapters: Array<{ n: number; id: string; title: string; added: boolean; files: Array<{ path: string; name: string; movedFrom: number | null }> }>;
  unplaced: string[];
  left: string[];
  summary: string;
  savedGuideId: string | null;
  signIn: string[] | null;
  memoryOnly: boolean;
  pendingPermissions: Array<{ id: number; title: string; kind: string | null; target: string | null; options: Array<{ optionId: string; name: string; kind: string }> }>;
  approvals: { auto: boolean; mode: string | null };
  offerAutoApprove: boolean;
  bottlenecks: Array<{ key: string; title: string; detail: string | null; action: "approveRun" | "resumeWithApproval" | null }>;
}

export interface AnswerListItem {
  id: string;
  question: string;
  sub: string;
  when: string;
  isNew: boolean;
  status: "answering" | "answered" | "text" | "stopped" | "failed";
}

export interface AnswerViewState {
  mode: "answer";
  id: string;
  question: string;
  kicker: string;
  agent: string;
  meta: string;
  jump: { label: string; link: string } | null;
  quote: { header: string; start: number; lines: string[] } | null;
  status: "answering" | "answered" | "text" | "stopped" | "failed";
  statusMessage: string | null;
  startedAt: number;
  endedAt: number | null;
  cost: string | null;
  activity: ActivityRow[];
  stream: string;
  page: { title: string; html: string } | null;
  text: string | null;
  stale: string | null;
  followUpOf: { id: string; question: string } | null;
  canFollowUp: boolean;
  pendingPermissions: GeneratingViewState["pendingPermissions"];
  offerAutoApprove: boolean;
  approvals: { auto: boolean; mode: string | null };
  signIn: string[] | null;
}

export type ViewState = HomeViewState | GeneratingViewState | AnswerViewState;

export interface LinkInfo {
  ok: boolean;
  label: string;
  location?: string;
  hover?: string;
  definedIn?: string;
  references?: number;
  chapter?: { n: number; title: string; reviewed: boolean; color: string };
  inChange: boolean;
  message?: string;
}

export type ToExtension =
  | { type: "ready" }
  | { type: "command"; command: string; args?: unknown[] }
  | { type: "link"; link: string; action: "open" | "definition" | "references" }
  | { type: "linkInfo"; reqId: number; link: string }
  | { type: "mermaidResult"; reqId: number; ok: boolean; message?: string; line?: number; unavailable?: boolean };

export type ToWebview =
  | { type: "state"; state: ViewState }
  | { type: "linkInfo"; reqId: number; info: LinkInfo }
  | { type: "checkMermaid"; reqId: number; source: string };

export const WEBVIEW_COMMANDS = [
  "newReview",
  "guideLocal",
  "guidePullRequest",
  "guideCurrentPR",
  "openGuide",
  "resumeDraft",
  "saveDraftAsIs",
  "deleteDraft",
  "cancel",
  "runInBackground",
  "openLocation",
  "openChapter",
  "changeDefaults",
  "openExternal",
  "refresh",
  "exportGuide",
  "signIn",
  "answerPermission",
  "approveRun",
  "approveAlways",
  "resumeWithApproval",
  "openAnswer",
  "followUp",
  "stopAnswer",
  "answerMenu",
  "openAnswerExternal",
] as const;

export type WebviewCommand = (typeof WEBVIEW_COMMANDS)[number];
