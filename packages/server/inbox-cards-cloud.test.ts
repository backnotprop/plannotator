/**
 * The card call for a paired cloud agent (inbox-mcp-cards.ts, reached through inbox-agent-door.ts): its list with no
 * project covers every project, and a refusal tells it to pass `project` (the door's field), never a folder it cannot
 * name. On a store, with no Inbox running. The door's own choice of project (a card_id's card, a thread's) is in
 * inbox-agent-door-parity.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxProject } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import type { InboxMcpContext } from "./inbox-mcp";
import { runCardCall, type CardCallInput } from "./inbox-mcp-cards";

const EVERY = "\u0000every";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-cards-cloud-")));
  roots.push(root);
  const store = InboxStore.open(join(root, "data"));
  const make = (name: string) => {
    mkdirSync(join(root, name), { recursive: true });
    return store.ensureProject({ name, root: join(root, name) });
  };
  const api = make("api");
  const web = make("web");
  const cloud = { kind: "agent" as const, host: "cloud-grok", session: "cloud.0123456789ab", name: "Nightly fixer" };
  const apiCard = store.createCard({ project_id: api.id, by: cloud, title: "Flaky test fix" }).card;
  const webCard = store.createCard({ project_id: web.id, by: cloud, title: "Header copy" }).card;
  const context = (cloudAgent: boolean): InboxMcpContext =>
    ({
      store,
      findProjects: async (path: string) => (path === EVERY ? { projects: [], unresolved: false, every: true } : { projects: [store.projectByRoot(path)].filter((p): p is InboxProject => p !== null), unresolved: false }),
      ...(cloudAgent ? { cloudAgent: { homeRoot: join(root, "data", "inbox", "cloud-agents", "x") } } : {}),
    }) as unknown as InboxMcpContext;
  const card = (cloudAgent: boolean, input: Partial<CardCallInput>) => runCardCall(context(cloudAgent), { agent_session: cloud.session, agent_host: cloud.host, agent_name: cloud.name, ...input } as CardCallInput);
  return { root, api, web, apiCard, webCard, card };
}

describe("a cloud agent's cards", () => {
  test("list with no project lists its cards in every project, each naming its project", async () => {
    const w = world();
    const all = await w.card(true, { op: "list", project_path: EVERY });
    expect((all.structured.cards as { id: string }[]).map((card) => card.id).sort()).toEqual([w.apiCard.id, w.webCard.id].sort());
    expect(all.structured.project).toBeNull();
    const lines = all.text.split("\n").filter((line) => line.startsWith("- "));
    expect(lines.find((line) => line.includes(w.apiCard.id))).toContain('project "api"');
    expect(lines.find((line) => line.includes(w.webCard.id))).toContain('project "web"');
    // One project named: that project's cards only, as before.
    const one = await w.card(true, { op: "list", project_path: join(w.root, "api") });
    expect((one.structured.cards as { id: string }[]).map((card) => card.id)).toEqual([w.apiCard.id]);
  });

  test("a card of another project is refused naming project (the door's field) for a cloud agent, project_path for an agent here", async () => {
    const w = world();
    const cloud = await w.card(true, { op: "say", card_id: w.webCard.id, say: "x", project_path: join(w.root, "api") }).catch((error: Error) => error.message);
    expect(cloud).toContain(`pass project ${w.web.id}`);
    expect(cloud).not.toContain("project_path");
    const here = await w.card(false, { op: "say", card_id: w.webCard.id, say: "x", project_path: join(w.root, "api") }).catch((error: Error) => error.message);
    expect(here).toContain(`pass project_path ${join(w.root, "web")}`);
  });

  test("a project with no Board yet tells a cloud agent to pass project, never a project_path", async () => {
    const w = world();
    const refused = await w.card(true, { op: "create", title: "New work", project_path: join(w.root, "nowhere") }).catch((error: Error) => error.message);
    expect(refused).toContain("pass project");
    expect(refused).not.toContain("project_path");
  });
});
