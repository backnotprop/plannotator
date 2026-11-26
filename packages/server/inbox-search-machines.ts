import { isInboxId } from "@plannotator/core/inbox-types";
import {
  INBOX_SEARCH_BROWSE_LIMIT,
  INBOX_SEARCH_CAPS,
  INBOX_SEARCH_GROUPS,
  INBOX_SEARCH_LIMIT_MAX,
  INBOX_SEARCH_RECENT_THREADS,
  type InboxSearchAnswer,
  type InboxSearchGroupId,
  type InboxSearchRow,
} from "@plannotator/shared/inbox/search";

export const INBOX_SEARCH_MACHINE_WAIT_MS = 2_500;

export interface InboxSearchMachine {
  id: string;
  name: string;
  online: boolean;
}

export interface InboxSearchMachines {
  linked(): InboxSearchMachine[];
  projectOwner(projectId: string): string | null;
  forward(req: Request, url: URL): Promise<Response | null>;
}

type Answer = InboxSearchAnswer & { serverSession: string; recent_searches?: string[] };

export interface SearchAcrossInput {
  req: Request;
  url: URL;
  machines: InboxSearchMachines;
  serverSession: string;
  waitMs: number;
  hasProject(id: string): boolean;
  answerOf(url: URL): Promise<Answer>;
}

type Page = { offset: number; limit: number } | null;

const byScore = <T extends { score?: number }>(rows: T[]): T[] =>
  rows.map((row, at) => ({ row, at })).sort((a, b) => (b.row.score ?? 0) - (a.row.score ?? 0) || a.at - b.at).map(({ row }) => row);

const byTime = <T extends { at: string }>(rows: T[]): T[] => {
  const time = (at: string) => Date.parse(at) || 0;
  return rows.map((row, at) => ({ row, at })).sort((a, b) => time(b.row.at) - time(a.row.at) || a.at - b.at).map(({ row }) => row);
};

const pagesTo = (want: number): Page[] =>
  Array.from({ length: Math.max(1, Math.ceil(want / INBOX_SEARCH_LIMIT_MAX)) }, (_, i) => ({ offset: i * INBOX_SEARCH_LIMIT_MAX, limit: Math.max(1, Math.min(INBOX_SEARCH_LIMIT_MAX, want - i * INBOX_SEARCH_LIMIT_MAX)) }));

export async function searchAcrossMachines(input: SearchAcrossInput): Promise<Answer> {
  const { req, url, machines, serverSession } = input;
  const own = new URL(url);
  own.searchParams.delete("machines");
  const linked = machines.linked();
  const nameOf = (id: string) => linked.find((machine) => machine.id === id)?.name ?? id;

  const ask = async (machine: string, params: URLSearchParams): Promise<InboxSearchAnswer | null> => {
    const target = new URL(`/api/inbox/m/${machine}/search?${params}`, url);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const asking = (async () => {
      const response = await machines.forward(new Request(target, { headers: req.headers, signal: AbortSignal.any([controller.signal, req.signal]) }), target);
      if (!response?.ok) return null;
      const body = (await response.json()) as InboxSearchAnswer | null;
      return body && typeof body === "object" && !body.indexing ? body : null;
    })().catch(() => null);
    try {
      return await Promise.race([asking, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), input.waitMs)))]);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
  const paramsAt = (page: Page) => {
    const params = new URLSearchParams(own.searchParams);
    if (page) {
      if (page.offset > 0) params.set("offset", String(page.offset));
      else params.delete("offset");
      params.set("limit", String(page.limit));
    }
    return params;
  };
  const tagged = <T extends InboxSearchRow>(rows: readonly T[] | null | undefined, machine: string): T[] => (rows ?? []).map((row) => ({ ...row, project: { ...row.project, machine } }));

  const project = own.searchParams.get("project");
  if (project && isInboxId("prj", project) && !input.hasProject(project)) {
    const owner = machines.projectOwner(project);
    if (owner) {
      const share = linked.some((machine) => machine.id === owner && machine.online) ? await ask(owner, paramsAt(null)) : null;
      const totals = share?.totals ?? Object.fromEntries(INBOX_SEARCH_GROUPS.map((id) => [id, 0]));
      const groups = share?.groups ? Object.fromEntries(Object.entries(share.groups).map(([id, rows]) => [id, tagged(rows, owner)])) : { threads: [] };
      return {
        serverSession,
        q: share?.q ?? own.searchParams.get("q") ?? "",
        terms: share?.terms ?? [],
        took_ms: share?.took_ms ?? 0,
        indexing: false,
        threads: share?.threads ?? 0,
        totals: totals as Answer["totals"],
        groups,
        recent: null,
        ...(share ? {} : { unanswered: [{ id: owner, name: nameOf(owner) }] }),
      };
    }
  }

  const answer = await input.answerOf(own);
  if (project || own.searchParams.has("tag") || answer.indexing || linked.length === 0) return answer;

  const group = own.searchParams.get("group") as InboxSearchGroupId | null;
  const offset = Number(own.searchParams.get("offset")) || 0;
  const limit = Number(own.searchParams.get("limit")) || null;
  const pages = group ? pagesTo(offset + (limit ?? INBOX_SEARCH_LIMIT_MAX)) : [null];
  const [mine, theirs] = await Promise.all([
    group ? Promise.all(pages.map((page) => input.answerOf(new URL(`${own.pathname}?${paramsAt(page)}`, own)))) : Promise.resolve([answer]),
    Promise.all(
      linked.map(async (machine) => {
        const shares = machine.online ? await Promise.all(pages.map((page) => ask(machine.id, paramsAt(page)))) : [null];
        return { machine, shares: shares.every(Boolean) ? (shares as InboxSearchAnswer[]) : null };
      }),
    ),
  ]);
  const answered = theirs.filter((one): one is { machine: InboxSearchMachine; shares: InboxSearchAnswer[] } => one.shares !== null);
  const missing = theirs.filter((one) => one.shares === null).map(({ machine }) => ({ id: machine.id, name: machine.name }));
  const unanswered = missing.length > 0 ? { unanswered: missing } : {};

  if (answer.recent) {
    const rows = [...answer.recent, ...answered.flatMap(({ machine, shares }) => tagged(shares[0]!.recent, machine.id))];
    return { ...answer, recent: byTime(rows).slice(0, INBOX_SEARCH_RECENT_THREADS), ...unanswered };
  }
  if (!answer.totals || !answer.groups) return { ...answer, ...unanswered };

  const totals = { ...answer.totals };
  for (const { shares } of answered) for (const id of INBOX_SEARCH_GROUPS) totals[id] += shares[0]!.totals?.[id] ?? 0;
  const groups = { ...answer.groups };
  const rowsOf = (id: InboxSearchGroupId) => [
    ...mine.flatMap((one) => one.groups?.[id] ?? []),
    ...answered.flatMap(({ machine, shares }) => shares.flatMap((share) => tagged(share.groups?.[id], machine.id))),
  ];
  if (group) groups[group] = byScore(rowsOf(group)).slice(offset, offset + (limit ?? INBOX_SEARCH_LIMIT_MAX));
  else {
    for (const id of INBOX_SEARCH_GROUPS) {
      if (!groups[id]) continue;
      const cap = Math.min(INBOX_SEARCH_LIMIT_MAX, limit ?? (answer.terms.length === 0 ? INBOX_SEARCH_BROWSE_LIMIT : INBOX_SEARCH_CAPS[id]));
      groups[id] = byScore(rowsOf(id)).slice(0, cap);
    }
  }
  return { ...answer, totals, groups, ...unanswered };
}
