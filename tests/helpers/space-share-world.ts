/**
 * A plan with everything a share can meet, in a plan library under `dataDir` (made-up words): a main page with four
 * versions (the second sent back with notes, the fourth approved by the person), three more pages (one a diagram),
 * three files (a picture, an HTML page, a picture), one comment not sent and three sent to the agent.
 */
import { NO_ACTOR } from "../../packages/core/plans";
import { createPlanStore, type PlanStore } from "../../packages/shared/plans/store";

const enc = (text: string) => new TextEncoder().encode(text);
const at = (day: number, hour = 10) => new Date(Date.UTC(2026, 10, day, hour)).toISOString();

/** A 1x1 PNG. */
export const TINY_PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

export const MAIN_VERSIONS = [
  "# Rate limiting for public endpoints\n\n## Context\n\nThe public API has no limit today.\n",
  "# Rate limiting for public endpoints\n\n## Context\n\nThe public API has no limit today. One client sent 40k requests in a minute last week.\n\n## Approach\n\n- Limit per IP address.\n",
  "# Rate limiting for public endpoints\n\n## Context\n\nThe public API has no limit today. One client sent 40k requests in a minute last week and slowed every other tenant.\n\n## Approach\n\n- Limit per API key, a token bucket that refills every second.\n- Answer `429` with a `Retry-After` header.\n",
  "# Rate limiting for public endpoints\n\n## Context\n\nThe public API has no limit today. One client sent 40k requests in a minute last week and slowed every other tenant.\n\n## Approach\n\n- Limit per API key, a token bucket that refills every second.\n- Answer `429` with a `Retry-After` header.\n- Keep counters in Redis so every node agrees.\n- If Redis is down, allow the request and count it locally.\n\n## Limits\n\n| Tier | Requests / minute | Burst |\n| --- | --- | --- |\n| Free | 60 | 120 |\n| Team | 600 | 1200 |\n| Enterprise | 6000 | 12000 |\n",
];

export interface SpaceShareWorld {
  store: PlanStore;
  plan: string;
  main: string;
  pages: { notes: string; flow: string; rollout: string };
  /** The comment not sent yet (`anno_…`), and the three sent. */
  unsent: string;
  sent: string[];
  /** The words of the "Changes asked" note on v2: they must never leave. */
  changesAsked: string;
}

export function seedSpaceShareWorld(dataDir: string, options: { versions?: number; approve?: boolean; extras?: boolean } = {}): SpaceShareWorld {
  const store = createPlanStore({ dataDir });
  const count = options.versions ?? 4;
  const extras = options.extras ?? true;
  const { plan, document } = store.createPlan({ name: "Rate limiting for public endpoints", project_name: "trailhead-api", created_at: at(10, 4), document: { title: "Rate limiting for public endpoints" } });
  const versions = MAIN_VERSIONS.slice(0, count).map((text, i) => store.addVersion(plan.id, document.id, { bytes: enc(text), committed_at: at(10 + Math.floor(i / 2), 4 + i * 2), source: "plan-review", author_via: "plan-review" }));
  const changesAsked = "Per IP punishes offices behind one address. Limit per key.";
  const decide = (n: number, decision: "approved" | "approved-with-notes" | "denied", feedback: string | null, when: string) =>
    store.addEvent(plan.id, { ...NO_ACTOR, author_via: "person", kind: "decision", at: when, subject: { document_id: document.id, version_number: n }, decision: { document_id: document.id, version: versions[n - 1]!.version, version_number: n, decision, at: when, feedback, feedback_record: null, snapshot: null }, legacy: null });
  if (count >= 2) decide(2, "denied", changesAsked, at(10, 7));
  if (options.approve ?? true) decide(count, "approved-with-notes", "Ship it behind the flag.", at(11, 11));

  const pages = { notes: "", flow: "", rollout: "" };
  if (extras) {
    const notes = store.addDocument(plan.id, { title: "Load test notes", created_at: at(10, 12) });
    store.addVersion(plan.id, notes.id, { bytes: enc("# Load test notes\n\nAt 2,000 requests a second the Redis round trip adds 0.4 ms at the median.\n"), committed_at: at(10, 12), source: "agent-tool" });
    const flow = store.addDocument(plan.id, { title: "Request flow", kind: "mermaid", created_at: at(10, 13) });
    store.addVersion(plan.id, flow.id, { bytes: enc("flowchart LR\n  C[Client] --> G[Gateway]\n  G --> L{Token bucket}\n  L -- allowed --> A[API]\n"), committed_at: at(10, 13), source: "agent-tool" });
    const rollout = store.addDocument(plan.id, { title: "Rollout checklist", created_at: at(10, 14) });
    store.addVersion(plan.id, rollout.id, { bytes: enc("# Rollout checklist\n\n- Turn on for internal keys.\n"), committed_at: at(10, 14), source: "agent-tool" });
    store.addVersion(plan.id, rollout.id, { bytes: enc("# Rollout checklist\n\n1. Turn on for internal keys.\n2. Watch the 429 rate for a day.\n"), committed_at: at(11, 9), source: "agent-tool" });
    Object.assign(pages, { notes: notes.id, flow: flow.id, rollout: rollout.id });
    store.addArtifact(plan.id, { asset_path: "architecture.png", title: "Architecture", content_type: "image/png", created_at: at(11, 9), bytes: TINY_PNG });
    store.addArtifact(plan.id, { asset_path: "dashboard-mockup.html", title: "Dashboard mockup", content_type: "text/html", created_at: at(11, 9), bytes: enc("<!doctype html><title>Rate limits</title><h1>Rate limits</h1><p>Last 24 hours, all public keys</p>") });
    store.addArtifact(plan.id, { asset_path: "load-test-chart.png", title: "Load test chart", content_type: "image/png", created_at: at(11, 9), bytes: new Uint8Array([...TINY_PNG, 0]) });
  }

  const head = versions[versions.length - 1]!;
  const comment = (id: string, text: string, when: string, extra: Record<string, unknown> = {}) =>
    store.saveComment(plan.id, { document_id: document.id, document_version: head.version, annotation: { id, blockId: "block-2", startOffset: 0, endOffset: 12, type: "COMMENT", text, originalText: "The public API", createdA: Date.parse(when), ...extra }, at: when });
  const sent = ["sent-1", "sent-2", "sent-3"].map((id, i) => comment(id, `Already with the agent ${i + 1}.`, at(11, 12 + i)).id);
  store.markCommentsSent(plan.id, ["sent-1", "sent-2", "sent-3"], { at: at(11, 16), message_id: "msg_1", to: { host: "claude-code", session: "s-1" } });
  const unsent = comment("open-1", "Should the Free tier burst be lower?", at(11, 17), { images: [{ path: "/tmp/one.png", name: "one" }, { path: "/tmp/two.png", name: "two" }] }).id;
  return { store, plan: plan.id, main: document.id, pages, unsent, sent, changesAsked };
}
