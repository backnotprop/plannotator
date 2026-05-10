/**
 * Vite plugin that mocks plannotator API endpoints for local development.
 *
 * Three plan versions are wired up so the Versions tab, the diff badge, and
 * the full word-level inline diff engine can all be exercised without running
 * a real hook session.
 *
 * ─── TOGGLE: default demo vs diff-engine stress test ─────────────────────
 *
 * Default (no flag): serves the Real-time Collaboration implementation plan
 * — the project's long-standing default demo. Pairs with DEMO_PLAN_CONTENT
 * in packages/editor/demoPlan.ts (wired through App.tsx).
 *
 * Diff-test (`VITE_DIFF_DEMO=1 bun run dev:hook`): serves the Auth Service
 * Refactor 20-case diff-engine stress test. Pairs with DIFF_DEMO_PLAN_CONTENT
 * in packages/editor/demoPlanDiffDemo.ts. Covers 20 numbered cases (①–⑳)
 * using realistic plan-shaped content — full paragraphs, complete code
 * blocks, lists, tables, blockquotes — each annotated with an identical
 * "What to watch for" blockquote label in both V2 and V3 so each case is
 * cleanly isolated in the diff view. ⑯–⑳ document known limitations.
 *
 * Both files check `VITE_DIFF_DEMO` on the same code path so the V3
 * (current plan) and V2 (previous plan) stay paired — you never get the
 * default V3 diffed against the test V2 or vice versa.
 *
 * The Versions Browser lets you select V1 as the base instead, which shows
 * a more structural diff (outline → full spec) within whichever mode is on.
 */
import type { Plugin } from 'vite';
import { existsSync, readFileSync, statSync } from 'fs';
import { resolve } from 'path';
import { isCodeFilePath } from '../../packages/shared/code-file';
import { preloadFile } from '@pierre/diffs/ssr';

// ─── Default plans (Real-time Collaboration) ─────────────────────────────
// What every dev sees when running `bun run dev:hook` without any flag.
// Matches the pre-branch demo content; kept identical so the project's
// default demo story doesn't change.
const PLAN_V1_DEFAULT = `# Implementation Plan: Real-time Collaboration

## Overview
Add real-time collaboration features to the editor using WebSocket connections.

## Phase 1: Infrastructure

### WebSocket Server
Set up a WebSocket server to handle concurrent connections:

\`\`\`typescript
const server = new WebSocketServer({ port: 8080 });

server.on('connection', (socket) => {
  const sessionId = generateSessionId();
  sessions.set(sessionId, socket);

  socket.on('message', (data) => {
    broadcast(sessionId, data);
  });
});
\`\`\`

### Client Connection
- Establish persistent connection on document load
- Implement reconnection logic with exponential backoff
- Handle offline state gracefully

### Database Schema

\`\`\`sql
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255) NOT NULL,
  content JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
\`\`\`

## Phase 2: Operational Transforms

> The key insight is that we need to transform operations against concurrent operations to maintain consistency.

Key requirements:
- Transform insert against insert
- Transform insert against delete
- Transform delete against delete

## Pre-launch Checklist

- [ ] Infrastructure ready
  - [ ] WebSocket server deployed
  - [ ] Database migrations applied
- [ ] Security audit complete
- [ ] Documentation updated

---

**Target:** Ship MVP in next sprint
`;

const PLAN_V2_DEFAULT = `# Implementation Plan: Real-time Collaboration

## Context

This proposal introduces real-time collaborative editing to the Plannotator editor, letting reviewers annotate the same plan simultaneously with sub-second visibility of each other's cursors and edits. We are targeting **early-access concurrency** for up to 25 active collaborators per document, with end-to-end edit-to-visible latency under 300ms at the 95th percentile. The implementation uses operational transforms running on a dedicated Node.js gateway that speaks \`Socket.IO\` to clients and \`REST\` to the storage tier. See [the technical design doc](https://docs.example.com/realtime-v1) for the full rationale and rollout plan.

Runtime parameters for phase one:

\`\`\`typescript
export const COLLAB_CONFIG = {
  maxCollaborators: 25,
  heartbeatIntervalMs: 5_000,
  operationBatchSize: 32,
  gateway: "wss://collab.plannotator.ai",
} as const;
\`\`\`

## Overview
Add real-time collaboration features to the editor using WebSocket connections and operational transforms.

## Phase 1: Infrastructure

### WebSocket Server
Set up a WebSocket server to handle concurrent connections:

\`\`\`typescript
const server = new WebSocketServer({ port: 8080 });

server.on('connection', (socket, request) => {
  const sessionId = generateSessionId();
  sessions.set(sessionId, socket);

  socket.on('message', (data) => {
    broadcast(sessionId, data);
  });
});
\`\`\`

### Client Connection
- Establish persistent connection on document load
  - Initialize WebSocket with authentication token
  - Set up heartbeat ping/pong every 30 seconds
- Implement reconnection logic with exponential backoff
  - Start with 1 second delay
  - Double delay on each retry (max 30 seconds)
- Handle offline state gracefully
  - Queue local changes in IndexedDB
  - Show offline indicator in UI

### Database Schema

\`\`\`sql
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255) NOT NULL,
  content JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE collaborators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  role VARCHAR(50) DEFAULT 'editor',
  cursor_position JSONB,
  last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_collaborators_document ON collaborators(document_id);
\`\`\`

## Phase 2: Operational Transforms

> The key insight is that we need to transform operations against concurrent operations to maintain consistency.

Key requirements:
- Transform insert against insert
  - Same position: use user ID for deterministic ordering
  - Different positions: adjust offset of later operation
- Transform insert against delete
  - Insert before delete: no change needed
  - Insert inside deleted range: special handling required
- Transform delete against delete
  - Non-overlapping: adjust positions
  - Overlapping: merge or split operations
- Maintain cursor positions across transforms

## Phase 3: UI Updates

1. Show collaborator cursors in real-time
2. Display presence indicators
3. Add conflict resolution UI
4. Implement undo/redo stack per user

## Pre-launch Checklist

- [ ] Infrastructure ready
  - [x] WebSocket server deployed
  - [x] Database migrations applied
  - [ ] Load balancer configured
- [ ] Security audit complete
  - [x] Authentication flow reviewed
  - [ ] Rate limiting implemented
- [x] Documentation updated

---

## Appendix: Diagrams

### Architecture

\`\`\`mermaid
flowchart LR
    subgraph Client["Client Browser"]
        UI[React UI] --> OT[OT Engine]
        OT <--> WS[WebSocket Client]
    end

    subgraph Server["Backend"]
        WSS[WebSocket Server] <--> OTS[OT Transform]
        OTS <--> DB[(PostgreSQL)]
    end

    WS <--> WSS
\`\`\`

---

**Target:** Ship MVP in next sprint
`;

// ─── V1: earliest rough draft (diff-test mode) ────────────────────────────
// Shows in the Versions Browser as the oldest entry.  Demonstrates a
// structural V1→V2 diff: mostly pure additions as the plan gets fleshed out.
const PLAN_V1_DIFF_TEST = `# Auth Service Refactor

## Goals

- Move from session cookies to JWTs
- Improve horizontal scalability
- Add proper token revocation

## Open Questions

- Which header should the token be sent in?
- Should we support refresh tokens in the first version?
- What expiry window makes sense (hours vs days)?
- How do we handle key rotation without downtime?

## Risks

- Client SDK breakage during migration
- Token revocation requires a Redis dependency
- Increased latency from revocation-list lookups
`;

// ─── V2: intermediate version ─────────────────────────────────────────────
// This is `previousPlan` — the diff baseline shown by default on load.
//
// Structure rule: every blockquote label and every surrounding line is
// IDENTICAL to V3 so they become unchanged context in the diff. Only the
// eight marked lines/sections actually differ.
//
// Differences vs V3 (each maps to the numbered case in the file header):
//   ① has "## Background" section (absent in V3)       → pure deletion
//   ② heading: "Security Model"   (V3: "Security Architecture") → heading inline diff
//   ③ paragraph: "**strong**"     (V3: "**proven**")            → bold inline diff
//   ④ paragraph: `Authorization`  (V3: `X-Auth-Token`)          → backtick gate
//   ⑤ code line: '1h'             (V3: '24h')                   → code-line edge case
//   ⑥ list item: "every request"  (V3: "each request")          → list-item inline diff
//   ⑦ checkbox:  "[ ]"            (V3: "[x]")                   → checkbox state gate
//   ⑧ no Observability section    (V3 has one)                  → pure addition
const PLAN_V2_DIFF_TEST = `# Auth Service Refactor — Diff Demo

This is a realistic plan document being used to exercise the word-level diff engine. Each case below is a real chunk of plan content — full paragraphs, complete code blocks, checklist items, tables — not line-by-line test fixtures. The blockquote label above each case explains in plain language what you should see when you click the **+N/−M** diff badge at the top of the page. Eighteen cases total: the first fifteen demonstrate expected behaviors; the last three surface known limitations discovered during an adversarial audit.

---

## ① Text Edits Scattered Through a Long Paragraph

> **What to watch for:** A long paragraph where several words changed mid-sentence. You should see each changed phrase highlighted inline — struck-through red for what was removed, green for what was added — with the surrounding text completely untouched. This is the most common edit pattern in real plans.

The authentication refactor will migrate the service from session cookies to stateless JWT tokens over a period of approximately six weeks. During this window, the legacy cookie-based flow will remain operational in parallel so we can shift traffic gradually through the existing load balancer rather than cutting over in a single deploy. Our rollback strategy depends on keeping both systems healthy until at least ninety-five percent of active clients have confirmed successful token exchange in production telemetry. The engineering team responsible for this migration includes two senior engineers, one tech lead, and a dedicated site reliability engineer from the platform team, with weekly checkpoint reviews held every Thursday morning.

---

## ② Bold Phrases Inside a Dense Paragraph

> **What to watch for:** A paragraph with several **bold phrases** scattered throughout. Some of the bold phrases were swapped for new ones; others stayed the same. The changed phrases should still render in bold weight — the bold formatting survives the swap because each bold token sits inside its own diff wrapper.

Password storage must use **bcrypt** with a work factor calibrated to match the target p99 login latency, and all tokens must be signed with **RS256** using keys stored in the cloud KMS with automatic rotation enabled. For inter-service communication we will use **mutual TLS** with certificates rotated every **ninety days**, pinned at the identity provider level so a compromised issuer cannot impersonate the auth service. Rate limiting at the edge will continue to be handled by **Cloudflare** with per-user quotas enforced after authentication, and the audit log pipeline will feed into **Datadog** for short-term retention and **S3 Glacier** for long-term compliance archival.

---

## ③ Paragraph with Inline Code Falls Back to Full Rewrite

> **What to watch for:** The paragraph below contains backtick-wrapped \`identifiers\`. When that happens, the engine gives up on inline word highlighting and shows the whole old paragraph struck-through above the whole new paragraph. This is a conservative safety measure — inline code spans and word-level diff markers don't mix cleanly with the current parser, so the engine prefers a correct but heavier render over a subtly broken inline one.

Configure the service by setting the \`AUTH_SECRET\` environment variable to a 64-byte base64-encoded random value generated with a cryptographically secure random source, and \`AUTH_PUBLIC_KEY\` to the matching public key for downstream verification. The \`TOKEN_TTL_SECONDS\` variable controls access token lifetime and defaults to 3600 seconds if unset, while \`REFRESH_TOKEN_TTL_SECONDS\` controls refresh token lifetime and defaults to 604800 seconds. For local development, set \`AUTH_MODE\` to \`development\` to bypass certificate verification against the internal CA; production deployments must instead set \`AUTH_MODE\` to \`production\` and provide the \`CA_CERT_PATH\` variable pointing at a valid certificate bundle stored on the container's mounted secrets volume.

---

## ④ Neighboring Heading and Paragraph Both Change

> **What to watch for:** When a heading and the paragraph immediately below it both change with no blank line between them, the engine can't cleanly separate the heading edit from the paragraph edit, so the whole pair falls back to block-level rendering. You'll see the old heading + paragraph rendered together struck-through, and the new heading + paragraph rendered together in green. This is the most common multi-block edit pattern in real plans.

### Phase One: Internal Beta Rollout
This phase targets approximately two hundred staff accounts drawn from the engineering and product organizations, with mandatory enrollment for all team members in those two orgs. Participants will be automatically enrolled in a feature flag that routes their authentication through the new token service, while all other users continue to use the legacy cookie flow until the next phase. Telemetry during this phase emphasizes end-to-end authentication latency, token validation error rates, and client-reported usability friction captured via an in-product feedback widget that surfaces immediately after the first post-migration login.

---

## ⑤ Section Heading Reworded

> **What to watch for:** A section heading that had one word swapped. Watch the heading itself show the inline strike/highlight — the word "Recovery" should appear struck through and "Restoration" highlighted green, both rendered at heading size and weight.

## Rollback and Recovery Procedure

If error rates exceed the published thresholds during any rollout phase, we will immediately revert the feature flag to its previous cohort size and kick off the incident response runbook published in the team wiki. The rollback itself is idempotent and takes under ninety seconds to propagate globally through the edge configuration cache.

---

## ⑥ Entire Section Removed

> **What to watch for:** A whole section — heading, paragraphs, and list — was cut from this version. You should see one large solid red block spanning all of the removed content. No inline word highlights; just a clean block indicating that everything inside was deleted wholesale.

*The V2 document contained a "## Deprecated Approaches" section at this position — heading, two paragraphs, and a list. In V3 it has been removed wholesale. Your diff view should render that content as one large solid red block immediately below.*

## Deprecated Approaches

We originally considered three alternative approaches before settling on the JWT design documented above. The first, session replication via a shared Redis cluster, was rejected due to the operational cost of running a stateful cache with strict availability guarantees across three regions. The second approach, opaque bearer tokens backed by a central database lookup, was rejected because the read amplification on every authenticated request would have required dedicated read replicas sized well beyond our current database capacity.

The third alternative we evaluated was maintaining the existing cookie-based flow indefinitely and investing in first-class multi-region cookie replication. This option was rejected after a detailed cost analysis showed that the engineering effort required to build and maintain reliable cross-region cookie invalidation would exceed the effort of the full JWT migration by at least a factor of three.

Other approaches we considered and rejected in less detail:

- SAML-based SSO with a central identity provider
- Client-side secure enclaves for local credential storage
- Custom binary token format with protobuf serialization

---

## ⑦ Entire Section Added

> **What to watch for:** A whole new section appears here that wasn't in the previous version. You should see one large solid green block spanning the new heading and all its content.

*The V3 document adds a new "## Post-Launch Monitoring and Runbooks" section at this position — heading, two paragraphs, and a list. In V2 this content did not exist. Your diff view should render the added content as one large solid green block immediately below.*

---

## ⑧ Long Code Block with a Single Line Edited

> **What to watch for:** A 25-line TypeScript class where only one inner line changed. The fence markers, imports, class declaration, and all unchanged method bodies should render as normal syntax-highlighted code. Only the one changed line should show inline red/green highlights on the specific values that differ.

\`\`\`ts
import { SignJWT, jwtVerify, type KeyLike } from "jose";

export interface TokenServiceConfig {
  signingKey: KeyLike;
  verificationKey: KeyLike;
  issuer: string;
  audience: string;
}

export class TokenService {
  private readonly signingKey: KeyLike;
  private readonly verificationKey: KeyLike;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly defaultTtlSeconds: number;

  constructor(config: TokenServiceConfig) {
    this.signingKey = config.signingKey;
    this.verificationKey = config.verificationKey;
    this.issuer = config.issuer;
    this.audience = config.audience;
    this.defaultTtlSeconds = 3600;
  }

  async issue(userId: string, scopes: string[] = []): Promise<string> {
    return new SignJWT({ sub: userId, scp: scopes })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setExpirationTime(\`\${this.defaultTtlSeconds}s\`)
      .sign(this.signingKey);
  }
}
\`\`\`

---

## ⑨ Long Code Block with Multiple Lines Edited

> **What to watch for:** The same class again, but this time three consecutive lines inside the \`verify\` method all changed. The engine sees those three changed lines as one modified block that doesn't look like a single line of prose, so it falls back to showing the whole old three-line chunk above the whole new three-line chunk. No inline word highlights inside the code.

\`\`\`ts
  async verify(token: string): Promise<TokenPayload | null> {
    try {
      const { payload } = await jwtVerify(token, this.verificationKey, {
        issuer: this.issuer,
        audience: this.audience,
        clockTolerance: "60s",
        maxTokenAge: "12h",
        algorithms: ["HS256"],
      });
      return {
        userId: payload.sub as string,
        scopes: (payload.scp as string[]) ?? [],
      };
    } catch (error) {
      logger.debug({ error }, "token verification failed");
      return null;
    }
  }
\`\`\`

---

## ⑩ Code Block Fully Rewritten in a New Language

> **What to watch for:** The fence language changed from \`javascript\` to \`typescript\` and the entire function body was rewritten from session-cookie logic to token-based logic. Since the engine treats code blocks as atomic units, you'll see the whole old JavaScript block struck-through above the whole new TypeScript block in green. No inline highlights — just a clean whole-block replacement.

\`\`\`javascript
const { getSession } = require("./sessionStore");

function authenticate(request) {
  const sessionId = request.cookies.sessionId;
  if (!sessionId) {
    throw new Error("missing session cookie");
  }
  const session = getSession(sessionId);
  if (!session || session.expiresAt < Date.now()) {
    throw new Error("session expired or invalid");
  }
  return {
    userId: session.userId,
    scopes: session.scopes || [],
  };
}

module.exports = { authenticate };
\`\`\`

---

## ⑪ Checkbox Text Edited (Check State Unchanged)

> **What to watch for:** A checked task whose wording was edited. Both versions of the task are checked — only the words changed — so the edit flows inline inside the list item with the checkbox still filled in.

- [x] Conduct a thorough security review of the authentication flow with at least two external reviewers from the platform security team before the first external customer is migrated

---

## ⑫ Checkbox State Toggled (Text Unchanged)

> **What to watch for:** A checkbox whose state toggled from unchecked to checked without any edit to the wording. The engine treats a state toggle as a structural change, not a text edit, so you'll see the old (unchecked) item struck-through above the new (checked) item in green — even though the text is word-for-word identical.

- [ ] Validate end-to-end key rotation flow in the staging environment at least once per week during the rollout window

---

## ⑬ Ordered List Item Reworded

> **What to watch for:** A numbered step in a procedure had one word swapped. Watch the item render with the step number intact and the one-word change shown inline.

5. Verify that every issued token carries a valid tenant claim and that the tenant claim matches the caller's primary tenant assignment.

---

## ⑭ Table Cell Value Changed

> **What to watch for:** A single row in a reference table had one cell value updated. Tables render as atomic blocks, so you'll see the old row struck-through above the new row in green. The header row, separator, and unchanged rows render as normal table context surrounding the single-row diff.

| Environment | Auth Method  | Access TTL | Refresh TTL |
|-------------|--------------|------------|-------------|
| Production  | JWT (RS256)  | 1 hour     | 7 days      |
| Staging     | JWT (HS256)  | 24 hours   | 30 days     |
| Development | JWT (HS256)  | 7 days     | 90 days     |

---

## ⑮ Blockquote Content Edited

> **What to watch for:** A blockquote (note / warning / callout) with its content reworded. Blockquotes don't qualify for inline word highlighting — the whole old blockquote is struck-through above the whole new blockquote in green. This matches the behavior for tables and code blocks.

> **Deprecation Note:** The legacy cookie-based authentication flow will remain operational in standby mode for thirty days after the last client has confirmed successful migration to token-based auth, providing a safety net for any edge-case flows that take longer than expected to cut over. Teams still running clients that depend on the cookie flow must complete their upgrade before the end of phase three or request an explicit extension through the auth team.

---

## ⑯ Fixed — Word Swap Inside a Multi-Word Bold Phrase

> **What to watch for:** When a single word inside a multi-word bold phrase changes — like **preliminary analysis** becoming **final analysis** — the diff engine atomizes the whole balanced \`**…**\` pair so it renders as a clean old-bold-struck + new-bold-green swap. Previously the closing \`**\` orphaned into unchanged-tail text and rendered as a literal asterisk; that limitation is resolved.

Before the leadership steering committee signs off on the external rollout phase, the team must complete a full pass over the **preliminary analysis** of load testing results, confirm that the error budget still permits the planned migration window, and escalate any unresolved dependencies to the program lead. Any open question at this stage must be either resolved or formally deferred to the post-launch review with named owners and dates.

---

## ⑰ Known Limitation — Word Swap Inside Link Text

> **What to watch for (another known glitch):** When a word inside the anchor text of a markdown link changes, the link still renders as a clickable \`<a>\` element, but the changed word shows up as literal HTML tag text — something like \`<del>old</del><ins>new</ins>\` — instead of styled diff highlights. The link parser captures the whole anchor text as a raw string before the diff markers get a chance to render.

For step-by-step guidance on running the automated migration harness against a local clone of the production database, see [the migration guide](https://docs.example.com/auth-migration) on the internal engineering wiki, which includes both the command-line recipe and a troubleshooting appendix covering the three most common failure modes observed during the staff rollout.

---

## ⑱ Known Limitation — User-Typed HTML Tags in Prose

> **What to watch for (final known glitch):** If the prose itself mentions the strings \`<ins>\` or \`<del>\` as literal text — for example, a plan that discusses HTML tagging conventions — the engine can't tell your typed tags apart from the diff markers it injected during rendering. The rendering in this case will be visibly garbled, with nested ins/del spans or dangling tag text visible in the UI.

For the audit log export format, mark newly added records with <ins> wrapper elements and mark deletions with <del> wrapper elements so downstream compliance tooling can reconstruct the chronological edit history of any given record. Both wrapper types must carry the corresponding actor identifier and timestamp as attributes, and nested edits must be preserved verbatim without collapsing intermediate revisions.

---

## ⑲ Known Limitation — Renumbered Ordered List Item

> **What to watch for (small cosmetic glitch):** The list item below changed from \`3.\` to \`4.\` between versions because a new step was inserted above it. The item TEXT is identical — only the numeral shifted. The engine treats this as a qualifying inline diff (same text, same list kind) but captures the numeral from the OLD version, so you will see the diff block render as "3." even though the current plan shows "4." in its source. This is purely cosmetic; the displayed content text is still correct.

3. Confirm rate limits are enforced on all public endpoints before exposing the service to external customers.

---

## ⑳ Known Limitation — Nested Fence (4-backtick wrapping 3-backtick)

> **What to watch for (corner case for docs-style plans):** When a plan uses a 4-backtick outer fence to wrap markdown that itself contains a 3-backtick example (common in CONTRIBUTING guides, style guides, blog posts about markdown), the fence-atomizer's regex stops at the inner 3-backtick closer instead of the outer 4-backtick closer. The outer block gets truncated, its closing fence is orphaned as a separate unchanged block, and the rendered diff looks broken in that area — similar cascade to what case ⑩ looked like before the fence-atomizer fix. The plain 3-backtick fences in cases ⑧, ⑨, ⑩ still render correctly because they're the single-level common case.

Update the CONTRIBUTING.md code-fence section to read:

\`\`\`\`md
For inline code blocks, use triple-backtick fences:

\`\`\`ts
const example = "hello";
\`\`\`

Use four backticks on an outer fence when you need to quote markdown source that itself contains a triple-backtick example, as this paragraph demonstrates.
\`\`\`\`

This change lands in section 3 of the contributor guide alongside the updated repository file layout overview.

---

## Open Questions

- Should we support refresh tokens in V1, or defer to V2 and ship access-only tokens first?
- Key rotation cadence: 30 days (current proposal) or 90 days (current legacy behavior)?
- Do we need a break-glass path for customer-managed keys in the first release, or is platform-managed sufficient for phase one?
`;

// Resolve which demo pair to serve. See file-header comment for the toggle.
// Accept "1", "true", or any truthy string so `VITE_DIFF_DEMO=1` or
// `VITE_DIFF_DEMO=true` both work. App.tsx does the symmetric check for V3.
const USE_DIFF_DEMO =
  process.env.VITE_DIFF_DEMO === "1" ||
  process.env.VITE_DIFF_DEMO === "true";

const PLAN_V1 = USE_DIFF_DEMO ? PLAN_V1_DIFF_TEST : PLAN_V1_DEFAULT;
const PLAN_V2 = USE_DIFF_DEMO ? PLAN_V2_DIFF_TEST : PLAN_V2_DEFAULT;

const now = Date.now();
const versions = [
  { version: 1, timestamp: new Date(now - 3600_000 * 4).toISOString() },
  { version: 2, timestamp: new Date(now - 3600_000 * 2).toISOString() },
  { version: 3, timestamp: new Date(now - 60_000).toISOString() },
];

const versionPlans: Record<number, string> = {
  1: PLAN_V1,
  2: PLAN_V2,
  // Version 3 is the current plan — served live by the editor (demoPlanDiffDemo.ts)
};

export function devMockApi(): Plugin {
  return {
    name: 'plannotator-dev-mock-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url === '/api/hooks/status') {
          res.setHeader('Content-Type', 'application/json');
          try {
            const { readImprovementHook } = await import('@plannotator/shared/improvement-hooks');
            const { loadConfig } = await import('@plannotator/shared/config');
            const { composeImproveContext } = await import('@plannotator/shared/pfm-reminder');
            const config = loadConfig();
            const hook = readImprovementHook('enterplanmode-improve');
            const pfmEnabled = config.pfmReminder === true;
            const composed = composeImproveContext({ pfmEnabled, improvementHookContent: hook?.content ?? null });
            res.end(JSON.stringify({
              pfmReminder: { enabled: pfmEnabled },
              improvementHook: {
                present: !!hook,
                filePath: hook?.filePath ?? null,
                fileSize: hook?.content?.length ?? null,
                content: hook?.content ?? null,
              },
              composedLength: composed?.length ?? null,
            }));
          } catch {
            res.end(JSON.stringify({
              pfmReminder: { enabled: false },
              improvementHook: { present: false, filePath: null, fileSize: null, content: null },
              composedLength: null,
            }));
          }
          return;
        }

        if (req.url === '/api/config' && req.method === 'POST') {
          let body = '';
          req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          req.on('end', async () => {
            try {
              const { saveConfig } = await import('@plannotator/shared/config');
              const parsed = JSON.parse(body);
              const toSave: Record<string, unknown> = {};
              if (parsed.pfmReminder !== undefined) toSave.pfmReminder = parsed.pfmReminder;
              if (Object.keys(toSave).length > 0) saveConfig(toSave as any);
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: true }));
            } catch {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'Invalid request' }));
            }
          });
          return;
        }

        if (req.url === '/api/plan') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            plan: undefined, // Editor uses its own DIFF_DEMO_PLAN_CONTENT
            origin: 'claude-code',
            previousPlan: PLAN_V2,
            versionInfo: { version: 3, totalVersions: 3, project: 'demo' },
            sharingEnabled: true,
          }));
          return;
        }

        if (req.url === '/api/plan/versions') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            project: 'demo',
            slug: 'auth-service-refactor',
            versions,
          }));
          return;
        }

        if (req.url?.startsWith('/api/plan/version?')) {
          const url = new URL(req.url, 'http://localhost');
          const v = Number(url.searchParams.get('v'));
          const plan = versionPlans[v];
          if (plan) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ plan, version: v }));
          } else {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'Version not found' }));
          }
          return;
        }

        if (req.url?.startsWith('/api/doc?')) {
          const url = new URL(req.url, 'http://localhost');
          const reqPath = url.searchParams.get('path');
          if (!reqPath) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'Missing path parameter' }));
            return;
          }
          const base = url.searchParams.get('base');
          const repoRoot = resolve(import.meta.dirname, '../..');
          const resolved = resolve(base || repoRoot, reqPath);
          if (!existsSync(resolved) || statSync(resolved).isDirectory()) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: `File not found: ${reqPath}` }));
            return;
          }
          const contents = readFileSync(resolved, 'utf-8');
          res.setHeader('Content-Type', 'application/json');
          if (isCodeFilePath(reqPath)) {
            const displayName = resolved.split('/').pop() || resolved;
            let prerenderedHTML: string | undefined;
            try {
              const result = await preloadFile({
                file: { name: displayName, contents },
                options: { disableFileHeader: true },
              });
              prerenderedHTML = result.prerenderedHTML;
            } catch { /* fall back to client-side rendering */ }
            res.end(JSON.stringify({ codeFile: true, contents, filepath: resolved, prerenderedHTML }));
          } else {
            res.end(JSON.stringify({ markdown: contents, filepath: resolved }));
          }
          return;
        }

        next();
      });
    },
  };
}
