/**
 * Every line Plannotator prints with a link in it ends the link at whitespace or the end of the text. A terminal
 * (and many agent UIs) makes a link of everything up to the next space: the Inbox's send answer once read
 * `(thread msg_…, http://localhost:59812/#thread=msg_…).`, and a click opened `…#thread=msg_…).`, a thread that
 * does not exist. The texts here come from their real builders (a real store and the tools' own handlers, no Inbox
 * server), each with a link in it, so a reworded line that puts punctuation back after its link fails here.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "../packages/shared/inbox/store";
import { createInboxMcpServer, type InboxMcpContext } from "../packages/server/inbox-mcp";
import { GUIDE_BRIEF_EXAMPLE } from "../packages/server/inbox-guides";
import { pullsChangeText } from "../packages/server/inbox-mcp-pulls";
import { prototypesNotFramedText } from "../packages/server/inbox-web-prototypes";
import { checkInboxLiveUrl } from "../packages/server/inbox-live";
import { buildForceAppFailureMessage } from "../packages/shared/live-probe";
import { explainTailscaleSetup } from "../packages/shared/tailscale";
import { INBOX_INSTALL_TEXT } from "../packages/shared/inbox/agent-link";
import { resolveAgentLaunch, KNOWN_AGENTS } from "../packages/acp-client/agents";
import { waitingDenyText } from "../apps/hook/hooks/mod/plan";
import { linksNotEndingClean } from "./helpers/printed-links";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const BASE = "http://localhost:59813/";
const GITLAB = "gitlab.acme.dev";

type Result = { content: { text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
type Handler = (input: Record<string, unknown>, ctx: unknown) => Promise<Result>;

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-printed-links-")));
  roots.push(root);
  const store = InboxStore.open(join(root, "data"));
  const project = store.ensureProject({ name: "api", root: join(root, "api") });
  const context = {
    store,
    baseUrl: () => BASE,
    resolveProject: async () => project,
    // A self-hosted GitLab: its PRs read back as their URLs, in the middle of a sentence.
    projectHost: async () => GITLAB,
  } as unknown as InboxMcpContext;
  const server = createInboxMcpServer(context) as unknown as { _registeredTools: Record<string, { handler: Handler }> };
  const tool = (name: string) => (input: Record<string, unknown>) =>
    server._registeredTools[name]!.handler({ project_path: project.root, agent_session: "ses_a", agent_host: "claude-code", ...input }, {});
  return { send: tool("send_message"), guide: tool("submit_guide") };
}

/** The texts, each paired with what produced it, so a failure names the builder. */
async function printedTexts(): Promise<[string, string][]> {
  const w = world();
  const texts: [string, string][] = [];
  const sent = async (label: string, result: Promise<Result>) => {
    const answer = await result;
    expect(answer.isError, `${label}: ${answer.content[0]?.text}`).toBeUndefined();
    texts.push([label, answer.content.map((part) => part.text).join("\n")]);
    return answer;
  };
  await sent("send_message", w.send({ body: "Done." }));
  await sent("send_message, naming the thread", w.send({ body: "Started.", thread: "retry policy" }));
  await sent("send_message, asking", w.send({ body: ":::question\nWhich retry policy?\n\n- [ ] Fixed delay\n- [ ] Backoff\n:::" }));
  await sent("send_message, with a PR read back as its URL", w.send({ body: "Opened acme/web!7.", pulls: ["acme/web!7"] }));
  const first = await sent("send_message, the first of a replay", w.send({ body: "Once.", idempotency_key: "k1" }));
  await sent("send_message, a replay", w.send({ body: "Once.", idempotency_key: "k1" }));
  await sent("send_message, a reply", w.send({ body: "And again.", reply_to: String(first.structuredContent?.message_id) }));
  await sent("submit_guide", w.guide({ ...GUIDE_BRIEF_EXAMPLE }));

  const pr = (n: number) => ({ pull: `${GITLAB}/acme/api#${n}:pull`, url: `https://${GITLAB}/acme/api/-/merge_requests/${n}` });
  texts.push(["pullsChangeText", pullsChangeText({ added: [pr(1), pr(2)], already: [pr(3)], removed: [pr(4)], missing: [{ key: pr(5).pull, url: pr(5).url }] as never })]);
  texts.push(["prototypesNotFramedText", prototypesNotFramedText(["https://preview.example.com/a", "http://localhost:5173/b"])]);
  for (const raw of ["", "not an address"]) {
    try {
      checkInboxLiveUrl(raw, []);
    } catch (error) {
      texts.push([`checkInboxLiveUrl(${JSON.stringify(raw)})`, (error as Error).message]);
    }
  }
  const probe = { plannotator: false, probeError: null, probeRedirectedTo: null };
  texts.push(["--app unreachable", buildForceAppFailureMessage("http://localhost:3000", { ...probe, probeError: "connect ECONNREFUSED" } as never)]);
  texts.push(["--app redirected", buildForceAppFailureMessage("http://localhost:3000", { ...probe, probeRedirectedTo: "https://login.example.com" } as never)]);
  for (const stdout of ["Logged out.\nLog in at: https://login.tailscale.com/a/xyz\n", "Serve is not enabled on your tailnet.\n"]) {
    texts.push([`tailscale: ${stdout.trim()}`, explainTailscaleSetup({ stdout, stderr: "", code: 1 } as never) ?? ""]);
  }
  texts.push(["INBOX_INSTALL_TEXT", INBOX_INSTALL_TEXT]);
  // An agent with no install command on Windows (Kiro): the message points at its docs.
  const docsOnly = KNOWN_AGENTS.map((agent) => [agent, resolveAgentLaunch(agent, {}, () => null, () => null, "win32")] as const).filter(([agent, launch]) => !launch.ok && launch.message.includes(agent.docsUrl));
  expect(docsOnly.length).toBeGreaterThan(0);
  for (const [agent, launch] of docsOnly) if (!launch.ok) texts.push([`resolveAgentLaunch(${agent.label})`, launch.message]);
  texts.push(["waitingDenyText", waitingDenyText(2, `${BASE}#plan=1`)]);
  return texts;
}

test("every printed link ends at whitespace or the end, never inside brackets or quotes", async () => {
  const texts = await printedTexts();
  // Each builder above printed a link: a builder that stopped printing one would pass here for nothing.
  for (const [label, text] of texts) expect(/https?:\/\//.test(text), `${label} carries a link`).toBe(true);
  const bad = texts.flatMap(([label, text]) => linksNotEndingClean(text).map((link) => `${label}: …${link}`));
  expect(bad).toEqual([]);
});

test("the check itself catches the old send line and passes the new one", () => {
  const url = `${BASE}#thread=msg_01M7VKGWJTN05MAA6M48FV0HY0`;
  expect(linksNotEndingClean(`Sent to the Plannotator Inbox (thread msg_01M7VKGWJTN05MAA6M48FV0HY0, ${url}). The person's reply arrives…`)).toHaveLength(1);
  expect(linksNotEndingClean(`Sent to the Plannotator Inbox, thread msg_01M7VKGWJTN05MAA6M48FV0HY0: ${url}\nThe person's reply arrives…`)).toEqual([]);
  expect(linksNotEndingClean(`See "${url}" there.`)).toHaveLength(1);
});
