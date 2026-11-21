/**
 * A made-up Inbox at a chosen size, written through the store's own code
 * (InboxStore, recordInboxAttachments, captureInboxInlineImages), so every
 * line is one the Inbox itself would write. For the performance harness
 * (scripts/inbox-perf/README.md): the store benchmark and the live baseline
 * read it.
 *
 *   bun scripts/inbox-perf/seed.ts --preset medium --out /tmp/inbox-perf/medium [--seed 1]
 *
 * `--out` must be a NEW folder inside the OS temp dir or /tmp. It gets:
 *   data/          the data dir (PLANNOTATOR_DATA_DIR): data/inbox/...
 *   src/           project folders, the small files attachments name, the images messages show
 *   manifest.json  what was made: counts, the long thread, every agent session (host, live or
 *                  ended, launched, the folder it says it works in), and how long seeding took
 *
 * The world: threads and messages (agents and the person), questions, answers,
 * replies delivered and pending, tags, hand-offs, attachments, images named by
 * path (some missing), launched-agent threads, Board cards, initiatives (tags),
 * routines (all off), snoozes, pins, archived threads, several projects (some
 * with folders that do not exist on this machine), and one 400-message thread.
 * Made-up plain content only. Deterministic shape for a seed (ids are random).
 * The Inbox must not be running on it.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inboxId, type InboxAttachment, type InboxAuthor, type InboxLaunchRecord, type InboxMessage } from "../../packages/core/inbox-types";
import { recordInboxAttachments } from "../../packages/shared/inbox/attachments";
import { captureInboxInlineImages } from "../../packages/shared/inbox/inline-images";
import { InboxStore } from "../../packages/shared/inbox/store";
import { refuseRealDataDir } from "../../tests/helpers/real-data-dir";

export interface PerfPreset {
  threads: number;
  messages: number;
  agents: number;
  projects: number;
}

export const PERF_PRESETS = {
  small: { threads: 200, messages: 2_000, agents: 5, projects: 4 },
  medium: { threads: 1_000, messages: 10_000, agents: 40, projects: 8 },
  large: { threads: 2_000, messages: 20_000, agents: 150, projects: 12 },
  huge: { threads: 5_000, messages: 60_000, agents: 400, projects: 20 },
} as const satisfies Record<string, PerfPreset>;

export type PerfPresetName = keyof typeof PERF_PRESETS;

/** The one long thread's length (the thread-read benchmark opens it). */
export const LONG_THREAD_MESSAGES = 400;

export interface PerfSession {
  host: string;
  session: string;
  /** Polls in the live baseline (scripts/inbox-perf/live.ts); the rest ended. */
  live: boolean;
  /** Started by the Inbox (a launched-agent thread's session). */
  launched: boolean;
  /** The folder it says it works in; `exists: false` for one on another machine. */
  folder: string;
  exists: boolean;
  /** A Claude Code session's loaded plugin (its polls say it): an older version here, or a folder of another machine. */
  plugin: { version: string; root: string } | null;
}

export interface PerfManifest {
  preset: PerfPresetName;
  seed: number;
  shape: PerfPreset;
  dataDir: string;
  src: string;
  counts: { threads: number; messages: number; personMessages: number; agentMessages: number; questions: number; answered: number; answerRefused: number; pending: number; tags: number; handoffs: number; attachments: number; images: number; missingImages: number; launched: number; cards: number; routines: number; initiatives: number; archived: number };
  longThread: string;
  /** A few ordinary threads (the live baseline reads one cold, one warm). */
  sampleThreads: string[];
  sessions: PerfSession[];
  projects: { id: string; name: string; root: string; exists: boolean }[];
  seedMs: number;
  dataBytes: number;
}

/** A small deterministic generator (mulberry32), so a seed makes the same shape. */
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

// Made-up people and projects: nothing here comes from any real data.
const PEOPLE = ["Charlie Dunn", "Ada Novak", "Bob Tully", "Dana Reyes", "Eli Marsh", "Fay Okafor", "Gus Lindqvist", "Hana Ito", "Ivo Brandt", "June Park"];
const PROJECT_NAMES = ["billing-api", "web-portal", "mobile-app", "data-pipeline", "docs-site", "infra-tools", "search-svc", "auth-gateway", "ledger", "reports", "notifications", "design-system", "edge-proxy", "batch-jobs", "admin-console", "analytics", "payments-sdk", "onboarding", "feature-flags", "status-page"];
const HOSTS = ["claude-code", "claude-code", "claude-code", "codex", "pi", "opencode"] as const;
const WORDS = "the a to of and in is for on that with it this be as are was by at or from an not have but we can if will so when all one there which more about up out then some into only other time new would also these two may first after should because how most over such where like even just used make each through very well".split(" ");
const TECH = "retry queue worker cache index cursor schema migration deploy rollback webhook token session lease timeout socket bundle manifest fixture snapshot budget throttle sampler histogram percentile pipeline release changelog checklist export import report ledger invoice refund payout batch cron flag rollout canary".split(" ");
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

function dirBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += dirBytes(path);
    else if (entry.isFile()) total += Bun.file(path).size;
  }
  return total;
}

export async function seedPerfInbox(options: { out: string; preset: PerfPresetName; seed?: number; log?: (line: string) => void }): Promise<PerfManifest> {
  const started = performance.now();
  const shape: PerfPreset = PERF_PRESETS[options.preset];
  if (!shape) throw new Error(`unknown preset ${options.preset}: one of ${Object.keys(PERF_PRESETS).join(", ")}`);
  const out = resolve(options.out);
  const dataDir = join(out, "data");
  const src = join(out, "src");
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`${out} is not empty: seed a NEW folder`);
  refuseRealDataDir(dataDir, "scripts/inbox-perf/seed.ts");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(src, { recursive: true });
  const log = options.log ?? (() => {});
  const seed = options.seed ?? 1;
  const random = rng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const chance = (p: number) => random() < p;

  const sentence = (n: number) => {
    const words = Array.from({ length: n }, () => (chance(0.3) ? pick(TECH) : pick(WORDS)));
    words[0] = words[0]!.charAt(0).toUpperCase() + words[0]!.slice(1);
    return `${words.join(" ")}.`;
  };
  const paragraph = (target: number) => {
    const lines: string[] = [];
    let size = 0;
    while (size < target) {
      const r = random();
      const line =
        r < 0.06
          ? `## ${sentence(4).slice(0, -1)}`
          : r < 0.1
            ? `\`\`\`ts\nconst ${pick(TECH)} = await load${pick(TECH)}(${Math.floor(random() * 1000)});\n\`\`\``
            : r < 0.16
              ? `- ${sentence(7)}`
              : r < 0.2
                ? `${pick(PEOPLE)} asked about the ${pick(TECH)} ${pick(TECH)} before the next release.`
                : sentence(8 + Math.floor(random() * 24));
      lines.push(line);
      size += line.length + 1;
    }
    return lines.join("\n");
  };
  const question = () => [":::question", `${sentence(7).slice(0, -1)}?`, "", `- [ ] ${sentence(3)}`, `- [ ] ${sentence(3)}`, `- [ ] ${sentence(2)}`, ":::"].join("\n");
  // Agent bodies average about 1 KB; one in 500 is a pasted log of about 30 KB.
  const agentBody = () => paragraph(chance(0.002) ? 30_000 : 200 + Math.floor(random() * 1_600));
  const personWords = () => paragraph(20 + Math.floor(random() * 300));

  // Time: the history runs over 60 days and ends an hour before now, so the list has today, this week and older.
  const end = Date.now() - 60 * 60_000;
  const step = (60 * 86_400_000) / (shape.messages * 1.2);
  let clock = end - 60 * 86_400_000;
  const store = InboxStore.open(dataDir, { now: () => new Date(clock) });
  const tick = () => {
    clock += step * (0.2 + random() * 1.6);
  };

  // Projects: three in four have a folder here; the rest name folders of another machine.
  const projects = Array.from({ length: shape.projects }, (_, i) => {
    const name = `${PROJECT_NAMES[i % PROJECT_NAMES.length]}${i >= PROJECT_NAMES.length ? `-${i}` : ""}`;
    const exists = i % 4 !== 3;
    const root = exists ? join(src, name) : i % 8 === 3 ? `/home/ada-novak/work/${name}` : `/Users/bob-tully-elsewhere/code/${name}`;
    if (exists) {
      mkdirSync(join(root, "docs"), { recursive: true });
      mkdirSync(join(root, "shots"), { recursive: true });
    }
    return { ...store.ensureProject({ name, root }), root, exists };
  });
  const localProjects = projects.filter((p) => p.exists);

  // The Claude Code plugin as the sandboxed Inbox's agent environment sees it (PLANNOTATOR_TEST_SANDBOX reads
  // <dataDir>/agents-home): installed at this version, so the restart judgment compares each live session's plugin.
  const version = (JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8")) as { version: string }).version;
  const pluginsDir = join(dataDir, "agents-home", ".claude", "plugins");
  const pluginFolder = (v: string) => join(pluginsDir, "cache", "plannotator", "plannotator", v);
  for (const v of [version, "0.28.60"]) {
    mkdirSync(join(pluginFolder(v), ".claude-plugin"), { recursive: true });
    writeFileSync(join(pluginFolder(v), ".claude-plugin", "plugin.json"), JSON.stringify({ name: "plannotator", version: v }));
  }
  writeFileSync(
    join(pluginsDir, "installed_plugins.json"),
    JSON.stringify({ version: 2, plugins: { "plannotator@plannotator": [{ scope: "user", version, installPath: pluginFolder(version), lastUpdated: new Date(end).toISOString() }] } }),
  );

  // Agent sessions: two in three are launched by the Inbox; about one in three is live in the live baseline.
  // A session in a project of another machine loaded its plugin there too (a folder this machine lacks).
  const sessions: (PerfSession & { project: (typeof projects)[number] })[] = Array.from({ length: shape.agents }, (_, i) => {
    const host = HOSTS[i % HOSTS.length]!;
    const project = projects[i % projects.length]!;
    const live = i % 3 === 0;
    const away = project.root.startsWith("/home/") ? "/home/ada-novak" : "/Users/bob-tully-elsewhere";
    const plugin = host !== "claude-code" ? null : project.exists ? { version: "0.28.60", root: pluginFolder("0.28.60") } : { version: "0.28.60", root: join(away, ".claude", "plugins", "cache", "plannotator", "plannotator", "0.28.60") };
    return { host, session: `ses_${host.replace("-", "")}_${String(i).padStart(4, "0")}`, live, launched: i % 3 !== 2, folder: project.root, exists: project.exists, plugin, project };
  });
  const agentOf = (s: (typeof sessions)[number]): Extract<InboxAuthor, { kind: "agent" }> => ({ kind: "agent", host: s.host, session: s.session, name: null });
  const wakes = (host: string) => host !== "codex";

  // Initiatives (the person's tags) to put threads in.
  const initiatives = Array.from({ length: Math.max(3, Math.round(shape.projects / 2)) }, (_, i) =>
    store.createInitiative({ name: `${pick(["Q4", "Launch", "Cleanup", "Perf", "Billing", "Mobile"])} ${pick(TECH)} ${i + 1}`, by: { kind: "person" } }),
  );

  const counts: PerfManifest["counts"] = { threads: 0, messages: 0, personMessages: 0, agentMessages: 0, questions: 0, answered: 0, answerRefused: 0, pending: 0, tags: 0, handoffs: 0, attachments: 0, images: 0, missingImages: 0, launched: 0, cards: 0, routines: 0, initiatives: initiatives.length, archived: 0 };
  let fileSerial = 0;
  let keySerial = 0;
  const key = (what: string) => `${what}-${++keySerial}`;

  const attachmentsFor = async (project: (typeof projects)[number]): Promise<InboxAttachment[] | undefined> => {
    if (!project.exists || !chance(0.04)) return undefined;
    const path = join(project.root, "docs", `${pick(TECH)}-${pick(TECH)}-${++fileSerial}.md`);
    writeFileSync(path, `# ${sentence(4)}\n\n${paragraph(400 + Math.floor(random() * 2_000))}\n`);
    const recorded = await recordInboxAttachments(store.dir, [path], { base: project.root, at: new Date(clock).toISOString() });
    counts.attachments += recorded.length;
    return recorded;
  };
  // About one agent message in 30 shows images by path; one image in three is missing (never written).
  const withImages = async (body: string, project: (typeof projects)[number]) => {
    if (!project.exists || !chance(0.033)) return { body, inline_images: undefined };
    const refs: string[] = [];
    for (let k = 0; k < 1 + Math.floor(random() * 3); k++) {
      const path = join(project.root, "shots", `shot-${++fileSerial}.png`);
      if (chance(0.67)) writeFileSync(path, PNG_1PX);
      else counts.missingImages += 1;
      refs.push(`![screenshot ${k + 1}](${path})`);
    }
    const shown = `${body}\n\n${refs.join("\n")}`;
    const captured = await captureInboxInlineImages(store.dir, { body: shown, root: project.root, anywhere: true, sentAt: new Date(clock).toISOString() });
    counts.images += captured.images.length;
    return { body: shown, inline_images: captured.images };
  };

  const agentSend = async (s: (typeof sessions)[number], input: { reply_to?: string; subject?: string; project?: (typeof projects)[number] }) => {
    tick();
    const project = input.project ?? s.project;
    const asks = chance(0.15);
    const images = await withImages(asks ? `${agentBody()}\n\n${question()}` : agentBody(), project);
    const attachments = await attachmentsFor(project);
    const message = store.sendMessage({
      project_id: project.id,
      author: agentOf(s),
      body: images.body,
      ...(input.reply_to ? { reply_to: input.reply_to } : { subject: input.subject ?? sentence(5).slice(0, 100) }),
      ...(images.inline_images ? { inline_images: images.inline_images } : {}),
      ...(attachments ? { attachments } : {}),
      wakes: wakes(s.host),
    }).message;
    counts.messages += 1;
    counts.agentMessages += 1;
    if (asks) counts.questions += store.questionsOf(message.id).length;
    return message;
  };

  // The person's reply to an agent message: answers its questions sometimes, tags another session sometimes,
  // hands the thread off rarely; delivered unless it is one of the recent ones (or one in 20 that never went).
  // Nothing waits for a launched session (always delivered, never tagged or handed from), so the live baseline's
  // Inbox has no reason to start one again (maybeRespawn needs a pending reply); the walks that look are still made.
  const personReply = (to: { id: string }, owner: (typeof sessions)[number], recent: boolean) => {
    tick();
    const open = store.questionsOf(to.id).filter((q) => q.state === "open");
    const questions = open.length > 0 && chance(0.7) ? open.map((q) => ({ key: q.key, revision: q.revision, answer: { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [q.choices[Math.floor(random() * q.choices.length)]?.label ?? ""] } })) : undefined;
    const other = pick(sessions);
    const tags = other.session !== owner.session && !other.launched && chance(0.05) ? [{ host: other.host, session: other.session, wakes: wakes(other.host) }] : undefined;
    const handoff = !tags && other.session !== owner.session && !other.launched && !owner.launched && other.live && chance(0.015) ? { to: { host: other.host, session: other.session }, from: { host: owner.host, session: owner.session, wakes: wakes(owner.host) } } : undefined;
    let reply: InboxMessage;
    try {
      reply = store.sendReply(to.id, { words: personWords(), idempotency_key: key("reply"), ...(questions ? { questions } : {}), ...(tags ? { tags } : {}), ...(handoff ? { handoff } : {}) }).reply;
      if (questions) counts.answered += questions.length;
    } catch {
      // An answer shape the question refuses: reply with words only.
      counts.answerRefused += 1;
      reply = store.sendReply(to.id, { words: personWords(), idempotency_key: key("reply"), ...(tags ? { tags } : {}) }).reply;
    }
    counts.messages += 1;
    counts.personMessages += 1;
    if (tags) counts.tags += 1;
    if (handoff) counts.handoffs += 1;
    const deliveredTo = handoff ? other : owner;
    // Sessions were live when the person wrote: most replies went, even to sessions that ended since.
    if (owner.launched || (!recent && !handoff && !chance(0.05))) {
      store.recordDelivery(reply.id, { host: deliveredTo.host, session: deliveredTo.session });
      if (tags && chance(0.6)) store.recordDelivery(store.deliveryIdOf(reply, tags[0]!.session), { host: tags[0]!.host, session: tags[0]!.session });
    } else counts.pending += 1;
    return reply;
  };

  // Message counts per thread: one long thread, the rest spread around the mean (1 to about 3x).
  const rest = shape.messages - LONG_THREAD_MESSAGES;
  const mean = rest / (shape.threads - 1);
  const sizes = Array.from({ length: shape.threads - 1 }, () => Math.max(1, Math.round(mean * (0.25 + random() * 1.5))));
  let total = sizes.reduce((a, b) => a + b, 0);
  for (let i = 0; total !== rest; i = (i + 1) % sizes.length) {
    if (total > rest && sizes[i]! > 1) (sizes[i]! -= 1), (total -= 1);
    else if (total < rest) (sizes[i]! += 1), (total += 1);
  }
  const longAt = Math.floor(sizes.length * 0.9);
  sizes.splice(longAt, 0, LONG_THREAD_MESSAGES);

  const threadIds: string[] = [];
  let longThread = "";
  const launchedBy = new Map<string, string>();
  for (let t = 0; t < sizes.length; t++) {
    const count = sizes[t]!;
    const owner = sessions[t % sessions.length]!;
    const recentThread = t > sizes.length * 0.97;
    let root: InboxMessage;
    let last: InboxMessage;
    if (owner.launched && !launchedBy.has(owner.session)) {
      // The launched agent's thread: the person's Send with the launch record, then the host's answer.
      tick();
      const launch: InboxLaunchRecord = { id: inboxId("lch"), agent: owner.host as InboxLaunchRecord["agent"], session_ref: null, folder: owner.project.root, scratch: false, started_at: new Date(clock).toISOString() };
      root = store.startPersonThread({ project_id: owner.project.id, body: personWords(), to: { host: owner.host, session: `launch:${launch.id}` }, idempotency_key: key("launch"), thread_name: `task-${t}`, launch }).message;
      tick();
      root = store.settleLaunch(root.id, { to: { host: owner.host, session: owner.session }, session_ref: `ref-${owner.session}` });
      store.recordDelivery(root.id, { host: owner.host, session: owner.session });
      launchedBy.set(owner.session, root.id);
      counts.launched += 1;
      counts.messages += 1;
      counts.personMessages += 1;
      last = count > 1 ? await agentSend(owner, { reply_to: root.id }) : root;
    } else if (chance(0.15) && owner.live) {
      // A New message the person started to a live session.
      tick();
      root = store.startPersonThread({ project_id: owner.project.id, body: personWords(), to: { host: owner.host, session: owner.session }, idempotency_key: key("new") }).message;
      store.recordDelivery(root.id, { host: owner.host, session: owner.session });
      counts.messages += 1;
      counts.personMessages += 1;
      last = count > 1 ? await agentSend(owner, { reply_to: root.id }) : root;
    } else {
      root = await agentSend(owner, { subject: sentence(4 + Math.floor(random() * 6)).slice(0, 110) });
      last = root;
    }
    let made = root.id === last.id ? 1 : 2;
    while (made < count) {
      // The thread goes back and forth; agents now and then send twice in a row.
      if (last.author.kind === "agent" && chance(0.75)) last = personReply(last, owner, recentThread && made > count - 3);
      else last = await agentSend(owner, { reply_to: root.id });
      made += 1;
    }
    threadIds.push(root.id);
    counts.threads += 1;
    if (count === LONG_THREAD_MESSAGES) longThread = root.id;
    // Read state, archive, snoozes, pins, tags.
    if (!recentThread && chance(0.8)) store.markSeen(root.id);
    if (!recentThread && chance(0.35)) {
      store.resolveThread(root.id, true, "person");
      counts.archived += 1;
    } else if (chance(0.02)) store.setSnooze(root.id, new Date(end + 3 * 86_400_000).toISOString());
    if (chance(0.01)) store.setPinned(root.id, true);
    if (chance(0.12)) store.setThreadTag(root.id, pick(initiatives).id, true);
    if (t % 500 === 499) log(`  ${t + 1} threads, ${counts.messages} messages`);
  }
  // Hand-offs past their Undo window settle, as the Inbox's sweep does.
  store.settleHandoffs(0);

  // Board cards: some per project, linked to threads of that project.
  const byProject = new Map<string, string[]>();
  for (const id of threadIds) {
    const projectId = store.message(id)!.project_id;
    byProject.set(projectId, [...(byProject.get(projectId) ?? []), id]);
  }
  const cardCount = Math.round(shape.threads / 25);
  for (let c = 0; c < cardCount; c++) {
    const project = projects[c % projects.length]!;
    const own = byProject.get(project.id) ?? [];
    tick();
    try {
      store.createCard({
        project_id: project.id,
        by: { kind: "person" },
        title: sentence(4).slice(0, -1),
        column: pick(["backlog", "todo", "in_progress", "done", "done"]),
        threads: own.length > 0 && chance(0.6) ? [pick(own)] : [],
        notes: chance(0.3) ? sentence(12) : undefined,
        idempotency_key: key("card"),
      });
      counts.cards += 1;
    } catch (error) {
      log(`  card skipped: ${(error as Error).message}`);
    }
  }

  // Routines: all off (the clock never starts a run), never approved.
  const routineCount = Math.max(2, Math.round(shape.projects / 2));
  for (let r = 0; r < routineCount; r++) {
    const at = new Date(clock).toISOString();
    store.putScheduledThread({
      id: inboxId("sch"),
      name: `${pick(["Nightly", "Weekly", "Morning"])} ${pick(TECH)} check ${r + 1}`,
      enabled: false,
      approved_at: null,
      prompt: sentence(14),
      schedule: { cron: pick(["0 9 * * 1-5", "30 2 * * *", "0 */6 * * *"]), tz: "America/New_York" },
      if_missed: "skip",
      runs_on: "this_computer",
      folder: { project_id: pick(localProjects).id },
      agent: "claude-code",
      attachments: [],
      thread_id: null,
      handled_through: null,
      created_at: at,
      updated_at: at,
    });
    counts.routines += 1;
  }

  const sampleThreads = [threadIds[Math.floor(threadIds.length * 0.5)]!, threadIds[Math.floor(threadIds.length * 0.75)]!, threadIds[threadIds.length - 2]!];
  const manifest: PerfManifest = {
    preset: options.preset,
    seed,
    shape,
    dataDir,
    src,
    counts,
    longThread,
    sampleThreads,
    sessions: sessions.map(({ project: _p, ...s }) => s),
    projects: projects.map((p) => ({ id: p.id, name: p.name, root: p.root, exists: p.exists })),
    seedMs: Math.round(performance.now() - started),
    dataBytes: dirBytes(dataDir),
  };
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const preset = (flag("--preset") ?? "small") as PerfPresetName;
  const out = flag("--out") ?? join(tmpdir(), `inbox-perf-${preset}-${Date.now()}`);
  const manifest = await seedPerfInbox({ out, preset, seed: Number(flag("--seed") ?? 1), log: (line) => process.stderr.write(`${line}\n`) });
  process.stdout.write(`${JSON.stringify({ out, seedMs: manifest.seedMs, dataBytes: manifest.dataBytes, counts: manifest.counts, longThread: manifest.longThread }, null, 2)}\n`);
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
