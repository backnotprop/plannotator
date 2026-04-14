/**
 * DIFF DEMO PLAN — V3 (diff-engine stress test)
 *
 * Opt-in dev fixture. NOT the default demo — this content is only served
 * when the dev server is launched with `VITE_DIFF_DEMO=1 bun run dev:hook`.
 * Without the flag, the editor renders packages/editor/demoPlan.ts (the
 * project's original Real-time Collaboration plan). The toggle lives in
 * packages/editor/App.tsx and the symmetric V2 toggle lives in
 * apps/hook/dev-mock-api.ts (same env var, same code path).
 *
 * Purpose: 20 numbered cases covering every code path in the word-level
 * inline diff engine. Full paragraphs, complete code blocks, real lists,
 * real tables, realistic plan shapes — not line-by-line fixtures. Each
 * case has an identical "What to watch for" blockquote label in V2 and V3,
 * so the diff view cleanly isolates each case. Cases ①–⑮ exercise
 * expected behaviors; ⑯–⑳ document known limitations.
 */
export const DIFF_DEMO_PLAN_CONTENT = `# Auth Service Refactor — Diff Demo

This is a realistic plan document being used to exercise the word-level diff engine. Each case below is a real chunk of plan content — full paragraphs, complete code blocks, checklist items, tables — not line-by-line test fixtures. The blockquote label above each case explains in plain language what you should see when you click the **+N/−M** diff badge at the top of the page. Eighteen cases total: the first fifteen demonstrate expected behaviors; the last three surface known limitations discovered during an adversarial audit.

---

## ① Text Edits Scattered Through a Long Paragraph

> **What to watch for:** A long paragraph where several words changed mid-sentence. You should see each changed phrase highlighted inline — struck-through red for what was removed, green for what was added — with the surrounding text completely untouched. This is the most common edit pattern in real plans.

The authentication refactor will migrate the service from session cookies to stateless JWT tokens over a period of approximately eight weeks. During this window, the legacy cookie-based flow will remain operational in parallel so we can shift traffic gradually through the existing service mesh rather than cutting over in a single deploy. Our rollback strategy depends on keeping both systems healthy until at least ninety-nine percent of active clients have confirmed successful token exchange in production telemetry. The engineering team responsible for this migration includes three senior engineers, one tech lead, and a dedicated site reliability engineer from the platform team, with weekly checkpoint reviews held every Thursday morning.

---

## ② Bold Phrases Inside a Dense Paragraph

> **What to watch for:** A paragraph with several **bold phrases** scattered throughout. Some of the bold phrases were swapped for new ones; others stayed the same. The changed phrases should still render in bold weight — the bold formatting survives the swap because each bold token sits inside its own diff wrapper.

Password storage must use **argon2id** with a work factor calibrated to match the target p99 login latency, and all tokens must be signed with **RS256** using keys stored in the cloud KMS with automatic rotation enabled. For inter-service communication we will use **mutual TLS** with certificates rotated every **sixty days**, pinned at the identity provider level so a compromised issuer cannot impersonate the auth service. Rate limiting at the edge will continue to be handled by **Cloudflare** with per-user quotas enforced after authentication, and the audit log pipeline will feed into **Honeycomb** for short-term retention and **S3 Glacier** for long-term compliance archival.

---

## ③ Paragraph with Inline Code Falls Back to Full Rewrite

> **What to watch for:** The paragraph below contains backtick-wrapped \`identifiers\`. When that happens, the engine gives up on inline word highlighting and shows the whole old paragraph struck-through above the whole new paragraph. This is a conservative safety measure — inline code spans and word-level diff markers don't mix cleanly with the current parser, so the engine prefers a correct but heavier render over a subtly broken inline one.

Configure the service by setting the \`AUTH_PRIVATE_KEY\` environment variable to a 2048-bit RSA private key in PEM format, and \`AUTH_PUBLIC_KEY\` to the matching public key for downstream verification. The \`ACCESS_TOKEN_TTL\` variable controls access token lifetime and defaults to 1800 seconds if unset, while \`REFRESH_TOKEN_TTL\` controls refresh token lifetime and defaults to 86400 seconds. For local development, set \`AUTH_MODE\` to \`dev\` to bypass certificate verification against the internal CA; production deployments must instead set \`AUTH_MODE\` to \`prod\` and provide the \`TLS_CERT_BUNDLE\` variable pointing at a valid certificate bundle stored on the container's mounted secrets volume.

---

## ④ Neighboring Heading and Paragraph Both Change

> **What to watch for:** When a heading and the paragraph immediately below it both change with no blank line between them, the engine can't cleanly separate the heading edit from the paragraph edit, so the whole pair falls back to block-level rendering. You'll see the old heading + paragraph rendered together struck-through, and the new heading + paragraph rendered together in green. This is the most common multi-block edit pattern in real plans.

### Phase One: Extended Staff Rollout
This phase targets approximately five hundred staff accounts drawn from the engineering, product, and customer-success organizations, with voluntary opt-in available for any full-time employee who wants to participate. Participants will be automatically enrolled in a feature flag that routes their authentication through the new token service, while all other users continue to use the legacy session flow until the next phase. Telemetry during this phase emphasizes end-to-end authentication latency, token rotation error rates, and client-reported usability friction captured via an in-product feedback widget that surfaces immediately after the first post-migration login.

---

## ⑤ Section Heading Reworded

> **What to watch for:** A section heading that had one word swapped. Watch the heading itself show the inline strike/highlight — the word "Recovery" should appear struck through and "Restoration" highlighted green, both rendered at heading size and weight.

## Rollback and Restoration Procedure

If error rates exceed the published thresholds during any rollout phase, we will immediately revert the feature flag to its previous cohort size and kick off the incident response runbook published in the team wiki. The rollback itself is idempotent and takes under ninety seconds to propagate globally through the edge configuration cache.

---

## ⑥ Entire Section Removed

> **What to watch for:** A whole section — heading, paragraphs, and list — was cut from this version. You should see one large solid red block spanning all of the removed content. No inline word highlights; just a clean block indicating that everything inside was deleted wholesale.

*The V2 document contained a "## Deprecated Approaches" section at this position — heading, two paragraphs, and a list. In V3 it has been removed wholesale. Your diff view should render that content as one large solid red block immediately below.*

---

## ⑦ Entire Section Added

> **What to watch for:** A whole new section appears here that wasn't in the previous version. You should see one large solid green block spanning the new heading and all its content.

*The V3 document adds a new "## Post-Launch Monitoring and Runbooks" section at this position — heading, two paragraphs, and a list. In V2 this content did not exist. Your diff view should render the added content as one large solid green block immediately below.*

## Post-Launch Monitoring and Runbooks

Once the rollout reaches one hundred percent of external traffic, we will maintain elevated pager coverage for fourteen days with a dedicated on-call rotation drawn from the authentication team and the platform SRE team. During this period, any alert related to authentication latency, token issuance errors, or key rotation failures will route to a dedicated Slack channel with automatic escalation to the principal engineer on call if not acknowledged within five minutes.

The monitoring pipeline will publish a daily digest summarizing authentication success rates broken down by client type, region, and token grant path. Any day that shows a success rate below ninety-nine point nine percent, or a p99 issuance latency above four hundred milliseconds, will automatically create a review ticket in the team's incident backlog for investigation during the following business day.

Known runbooks maintained for this launch window:

- Key rotation emergency rollback procedure
- Revocation list cache invalidation procedure
- Mutual TLS certificate renewal procedure
- Legacy cookie flow re-enable procedure (break-glass)

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
    this.defaultTtlSeconds = 1800;
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
        clockTolerance: "30s",
        algorithms: ["RS256", "RS384"],
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

\`\`\`typescript
import type { Request } from "express";
import { jwtVerify } from "jose";
import { verificationKey } from "./keys";

export interface AuthContext {
  userId: string;
  scopes: readonly string[];
}

export async function authenticate(request: Request): Promise<AuthContext | null> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }
  const token = authHeader.slice("Bearer ".length);
  try {
    const { payload } = await jwtVerify(token, verificationKey);
    return {
      userId: payload.sub as string,
      scopes: (payload.scp as string[]) ?? [],
    };
  } catch {
    return null;
  }
}
\`\`\`

---

## ⑪ Checkbox Text Edited (Check State Unchanged)

> **What to watch for:** A checked task whose wording was edited. Both versions of the task are checked — only the words changed — so the edit flows inline inside the list item with the checkbox still filled in.

- [x] Conduct an independent security review of the authentication flow with at least two external reviewers from the platform security team before the first external customer is migrated

---

## ⑫ Checkbox State Toggled (Text Unchanged)

> **What to watch for:** A checkbox whose state toggled from unchecked to checked without any edit to the wording. The engine treats a state toggle as a structural change, not a text edit, so you'll see the old (unchecked) item struck-through above the new (checked) item in green — even though the text is word-for-word identical.

- [x] Validate end-to-end key rotation flow in the staging environment at least once per week during the rollout window

---

## ⑬ Ordered List Item Reworded

> **What to watch for:** A numbered step in a procedure had one word swapped. Watch the item render with the step number intact and the one-word change shown inline.

5. Verify that every issued token carries a valid tenant identifier and that the tenant identifier matches the caller's primary tenant assignment.

---

## ⑭ Table Cell Value Changed

> **What to watch for:** A single row in a reference table had one cell value updated. Tables render as atomic blocks, so you'll see the old row struck-through above the new row in green. The header row, separator, and unchanged rows render as normal table context surrounding the single-row diff.

| Environment | Auth Method  | Access TTL | Refresh TTL |
|-------------|--------------|------------|-------------|
| Production  | JWT (RS256)  | 30 minutes | 7 days      |
| Staging     | JWT (HS256)  | 24 hours   | 30 days     |
| Development | JWT (HS256)  | 7 days     | 90 days     |

---

## ⑮ Blockquote Content Edited

> **What to watch for:** A blockquote (note / warning / callout) with its content reworded. Blockquotes don't qualify for inline word highlighting — the whole old blockquote is struck-through above the whole new blockquote in green. This matches the behavior for tables and code blocks.

> **Deprecation Note:** The legacy cookie-based authentication flow will be fully deactivated immediately after the last client has confirmed successful migration to token-based auth, with no grace period beyond the rollout window itself. Teams still running clients that depend on the cookie flow must complete their upgrade before the end of phase three or request an explicit extension through the auth team.

---

## ⑯ Known Limitation — Word Swap Inside a Multi-Word Bold Phrase

> **What to watch for (this is a known glitch):** When a single word inside a multi-word bold phrase changes — like **preliminary analysis** becoming **final analysis** — the engine splits the bold markers across the change boundary. You will likely see raw \`**\` asterisks rendered as literal text and the word "analysis" lose its bold styling. This is a boundary case we haven't fixed yet; it was surfaced by an adversarial audit of the engine.

Before the leadership steering committee signs off on the external rollout phase, the team must complete a full pass over the **final analysis** of load testing results, confirm that the error budget still permits the planned migration window, and escalate any unresolved dependencies to the program lead. Any open question at this stage must be either resolved or formally deferred to the post-launch review with named owners and dates.

---

## ⑰ Known Limitation — Word Swap Inside Link Text

> **What to watch for (another known glitch):** When a word inside the anchor text of a markdown link changes, the link still renders as a clickable \`<a>\` element, but the changed word shows up as literal HTML tag text — something like \`<del>old</del><ins>new</ins>\` — instead of styled diff highlights. The link parser captures the whole anchor text as a raw string before the diff markers get a chance to render.

For step-by-step guidance on running the automated migration harness against a local clone of the production database, see [the upgrade guide](https://docs.example.com/auth-migration) on the internal engineering wiki, which includes both the command-line recipe and a troubleshooting appendix covering the three most common failure modes observed during the staff rollout.

---

## ⑱ Known Limitation — User-Typed HTML Tags in Prose

> **What to watch for (final known glitch):** If the prose itself mentions the strings \`<ins>\` or \`<del>\` as literal text — for example, a plan that discusses HTML tagging conventions — the engine can't tell your typed tags apart from the diff markers it injected during rendering. The rendering in this case will be visibly garbled, with nested ins/del spans or dangling tag text visible in the UI.

For the audit log export format, mark newly inserted records with <ins> wrapper elements and mark removals with <del> wrapper elements so downstream compliance tooling can reconstruct the chronological edit history of any given record. Both wrapper types must carry the corresponding actor identifier and timestamp as attributes, and nested edits must be preserved verbatim without collapsing intermediate revisions.

---

## ⑲ Known Limitation — Renumbered Ordered List Item

> **What to watch for (small cosmetic glitch):** The list item below changed from \`3.\` to \`4.\` between versions because a new step was inserted above it. The item TEXT is identical — only the numeral shifted. The engine treats this as a qualifying inline diff (same text, same list kind) but captures the numeral from the OLD version, so you will see the diff block render as "3." even though the current plan shows "4." in its source. This is purely cosmetic; the displayed content text is still correct.

4. Confirm rate limits are enforced on all public endpoints before exposing the service to external customers.

---

## ⑳ Known Limitation — Nested Fence (4-backtick wrapping 3-backtick)

> **What to watch for (corner case for docs-style plans):** When a plan uses a 4-backtick outer fence to wrap markdown that itself contains a 3-backtick example (common in CONTRIBUTING guides, style guides, blog posts about markdown), the fence-atomizer's regex stops at the inner 3-backtick closer instead of the outer 4-backtick closer. The outer block gets truncated, its closing fence is orphaned as a separate unchanged block, and the rendered diff looks broken in that area — similar cascade to what case ⑩ looked like before the fence-atomizer fix. The plain 3-backtick fences in cases ⑧, ⑨, ⑩ still render correctly because they're the single-level common case.

Update the CONTRIBUTING.md code-fence section to read:

\`\`\`\`md
For inline code blocks, use triple-backtick fences with a language tag for syntax highlighting:

\`\`\`ts
const example = "world";
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
