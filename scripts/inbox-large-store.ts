/**
 * A very large Inbox store, written straight into a scratch data dir: by
 * default 4,000 threads, 30,000 messages, about 60 MB of text, 40 projects
 * with non-Latin names, questions and attachments (the inbox-search brief's
 * worst case, section 11). Deterministic: the same seed writes the same store.
 *
 * Used by scripts/inbox-search-bench.ts (search over it) and
 * tests/e2e/inbox-memory-soak.spec.ts (the window's memory over it). Node-safe
 * (no Bun APIs): the Playwright specs import it under node. The Inbox must not
 * be running on the data dir (the store has one writer). Only a scratch data
 * dir is accepted (tests/helpers/real-data-dir.ts).
 */

import { inboxId, type InboxAuthor } from "../packages/core/inbox-types";
import type { InboxAttachment } from "../packages/core/inbox-types";
import { InboxStore } from "../packages/shared/inbox/store";
import { refuseRealDataDir } from "../tests/helpers/real-data-dir";

export interface SeedShape {
  threads: number;
  messages: number;
  projects: number;
  /** Target bytes of message text in total. */
  textBytes: number;
}

export const WORST_CASE: SeedShape = { threads: 4000, messages: 30000, projects: 40, textBytes: 60 * 1024 * 1024 };

/** A small deterministic generator, so two runs seed the same store. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COMMON = "the a to of and in is for on that with it this be as are was by at or from an not have but we can if will so when all one there which their more about up out then them some into only other time could new would also these two may first any after should because how most our over such where like even just used make each through very well".split(" ");
const TECH = "relay mailbox rate limit retry storm jitter backoff deploy rollback migration schema index cursor pagination webhook queue worker cache manifest bundle cdn latency timeout socket handshake token session lease claim delivery thread project decision guide review attachment pairing tailnet listener certificate bonjour pipeline nightly build release checklist changelog fixture snapshot invariant replay idempotency budget throttle sampler tracer metrics histogram percentile allocator compactor posting vocabulary tokenizer segmenter grapheme normalization diacritic folding".split(" ");
const SYLLABLES = "ka lo mi ne su ta ri po ve da zu fe gi ho ja ku le mo na pi qu ro si tu vo wa xi yo ze".split(" ");
const JAPANESE = ["決済", "サービス", "デプロイ", "エラー", "調査", "タイムアウト", "接続", "上限", "修正", "原因"];
const ARABIC = ["تقرير", "أخطاء", "الدفع", "الخادم", "النشر", "مهلة", "الاتصال", "قاعدة", "البيانات"];
const PROJECT_NAMES = ["plannotator", "workspaces", "api", "web", "billing-svc", "docs-site", "決済サービス", "بوابة-الدفع", "northwind-industries-holdings-customer-portal-frontend", "relay", "mobile", "infra"];

/**
 * `unique`: the share of words replaced by a token seen nowhere else, as
 * agents write them: `ids` mixes commit hashes, ULIDs, UUIDs, timestamps,
 * large numbers and random file names; `words` is random lower-case words,
 * the case no id rule can tell from a real word.
 */
export interface UniqueMix {
  share: number;
  kind: "ids" | "words";
}

export function seedInboxSearchWorld(dataDir: string, shape: SeedShape = WORST_CASE, seed = 1, unique: UniqueMix = { share: 0, kind: "ids" }): { store: InboxStore; textChars: number; threadIds: string[] } {
  refuseRealDataDir(dataDir, "scripts/inbox-search-bench.ts");
  const random = rng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const invented = Array.from({ length: 4000 }, () => Array.from({ length: 2 + Math.floor(random() * 3) }, () => pick(SYLLABLES)).join(""));
  // Text is topical, as a real inbox is: common English everywhere, and each
  // project its own technical words (60 from a pool of 1,500, Zipf-weighted
  // inside the project), so "rate limit" is frequent in a few projects and
  // rare elsewhere. The named words are spread over several projects each.
  const pool = [...TECH, ...Array.from({ length: 1500 - TECH.length }, () => `${pick(SYLLABLES)}${pick(SYLLABLES)}${pick(["er", "or", "ing", "ment", "ity", "set", "map"])}`)];
  const topics = Array.from({ length: shape.projects }, (_, i) => {
    const own = Array.from({ length: 60 }, () => pool[Math.floor(random() * pool.length)]!);
    // Each named word leads in a few projects.
    for (let k = 0; k < 6; k++) own[k] = TECH[(i * 6 + k) % TECH.length]!;
    return own;
  });
  let topical = topics[0]!;
  const zipf = (n: number) => Math.min(n - 1, Math.floor(Math.exp(random() * Math.log(n + 1)) - 1));
  const HEX = "0123456789abcdef";
  const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const LOWER = "abcdefghijklmnopqrstuvwxyz";
  const chars = (alphabet: string, n: number) => Array.from({ length: n }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
  let serial = 0;
  const uniqueToken = (): string => {
    serial += 1;
    if (unique.kind === "words") return chars(LOWER, 5 + Math.floor(random() * 8));
    const r = random();
    if (r < 0.25) return chars(HEX, random() < 0.5 ? 40 : 9);
    if (r < 0.45) return `msg_${chars(B32, 26)}`;
    if (r < 0.6) return `${chars(HEX, 8)}-${chars(HEX, 4)}-${chars(HEX, 4)}-${chars(HEX, 4)}-${chars(HEX, 12)}`;
    if (r < 0.75) return String(1_700_000_000_000 + serial * 7919 + Math.floor(random() * 1000));
    if (r < 0.85) return new Date(Date.UTC(2026, 9, 1) + Math.floor(random() * 28 * 86_400_000)).toISOString();
    return "/tmp/run-" + chars(LOWER + "0123456789", 8) + "/out-" + chars(LOWER, 6) + ".log";
  };
  const word = (): string => {
    if (unique.share > 0 && unique.share > random()) return uniqueToken();
    const r = random();
    if (r < 0.45) return pick(COMMON);
    if (r < 0.7) return topical[zipf(topical.length)]!;
    if (r < 0.985) return invented[Math.floor(Math.pow(random(), 2) * invented.length)]!;
    if (r < 0.993) return pick(JAPANESE);
    return pick(ARABIC);
  };
  const sentence = (n: number) => {
    const words = Array.from({ length: n }, word);
    words[0] = words[0]!.charAt(0).toUpperCase() + words[0]!.slice(1);
    return `${words.join(" ")}.`;
  };
  let clock = Date.parse("2026-06-01T09:00:00Z");
  const store = InboxStore.open(dataDir, { now: () => new Date((clock += 7_000)) });
  const projects = Array.from({ length: shape.projects }, (_, i) => {
    const name = `${PROJECT_NAMES[i % PROJECT_NAMES.length]}${i >= PROJECT_NAMES.length ? `-${i}` : ""}`;
    return store.ensureProject({ name, root: `/src/${i}/${name}` });
  });
  const perMessage = Math.round(shape.textBytes / shape.messages);
  let textChars = 0;
  const threadIds: string[] = [];
  const body = (target: number, withQuestion: boolean): string => {
    const lines: string[] = [];
    let size = 0;
    while (size < target) {
      const r = random();
      let line: string;
      if (r < 0.06) line = `## ${sentence(4)}`;
      else if (r < 0.1) line = `\`\`\`ts\nconst ${pick(TECH)} = await ${pick(TECH)}(${Math.floor(random() * 1000)});\n\`\`\``;
      else if (r < 0.13) line = `See https://ci.example.com/pipelines/${pick(TECH)}/jobs/${Math.floor(random() * 1e7)}/artifacts/raw/${pick(TECH)}.log?attempt=2 for the log.`;
      else if (r < 0.2) line = `- ${sentence(8)}`;
      else line = sentence(8 + Math.floor(random() * 30));
      lines.push(line);
      size += line.length + 1;
    }
    if (withQuestion) lines.push("", ":::question", `${sentence(9).slice(0, -1)}?`, "", `- [ ] ${sentence(3)}`, `- [ ] ${sentence(3)}`, `- [ ] ${sentence(3)}`, ":::");
    return lines.join("\n");
  };
  let sent = 0;
  for (let t = 0; t < shape.threads; t++) {
    const project = projects[t % projects.length]!;
    topical = topics[t % projects.length]!;
    const author: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: pick(["claude-code", "pi", "opencode", "codex"]), session: `ses_${t}`, name: null };
    const count = Math.max(1, Math.round((shape.messages / shape.threads) * (0.4 + random() * 1.2)));
    let root: string | null = null;
    for (let m = 0; m < count && (m === 0 || sent < shape.messages); m++) {
      // One message in a thousand is huge (a pasted log: up to ~120 KB).
      const target = random() < 0.001 ? 120_000 : Math.round(perMessage * (0.3 + random() * 1.4));
      const text = body(target, random() < 0.12);
      textChars += text.length;
      const attachments: InboxAttachment[] | undefined =
        random() < 0.05
          ? [{ id: inboxId("att"), path: `/src/${project.name}/docs/${pick(TECH)}-${pick(TECH)}.md`, named_path: null, name: `${pick(TECH)}-${pick(TECH)}.md`, kind: "markdown", sent_sha256: "0".repeat(64), size: 100, sent_at: new Date(clock).toISOString(), sent_mtime: new Date(clock).toISOString() }]
          : undefined;
      const message = store.sendMessage({
        project_id: project.id,
        author,
        subject: root ? null : sentence(5 + Math.floor(random() * 6)).slice(0, 120),
        body: text,
        reply_to: root,
        thread: root ? null : `t${t}`,
        ...(attachments ? { attachments } : {}),
      }).message;
      sent += 1;
      if (!root) {
        root = message.id;
        threadIds.push(root);
      }
    }
    if (random() < 0.6) store.markSeen(root!);
    if (random() < 0.25) store.resolveThread(root!, true);
  }
  return { store, textChars, threadIds };
}
