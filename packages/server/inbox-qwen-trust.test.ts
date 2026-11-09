/**
 * Plannotator as Qwen Code's trusted sender (inbox-qwen-trust.ts): minted
 * when the connect step connects Qwen Code, revoked when Qwen Code is turned
 * off or Plannotator is uninstalled. A fake `qwen` on a scratch PATH keeps
 * its grants in the scratch Qwen home as Qwen does
 * (tests/helpers/fake-agents.ts); the real qwen is never run and the real
 * ~/.qwen never read.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import { connectInboxAgents, createAgentEnvironmentFor, formatConnectReport, planInboxAgentRemoval, readInboxAgents, setInboxAgentReach, type AgentEnvironment } from "./inbox-agents";
import {
  QWEN_TRUST_REVOKED_REASON,
  checkQwenTrust,
  ensureQwenTrust,
  parseQwenVersion,
  qwenHasTrust,
  qwenTrustLabel,
  qwenTrustPath,
  qwenTrustRemoval,
  qwenWakeToken,
  readQwenTrust,
} from "./inbox-qwen-trust";

const SELF = ["/opt/plannotator/bin/plannotator"];

/** Whether the scratch volume ignores case (macOS and Windows by default; Linux never), looked at, never assumed. */
const IGNORES_CASE = (() => {
  const probe = mkdtempSync(join(tmpdir(), "plannotator-case-"));
  try {
    mkdirSync(join(probe, "q"));
    return existsSync(join(probe, "Q"));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();
const OURS = [...SELF, "inbox", "mcp"];

let fake: FakeAgents;
let dataDir: string;
let savedDataDir: string | undefined;

beforeEach(() => {
  fake = createFakeAgents("plannotator-qwen-trust-");
  dataDir = join(fake.root, "data");
  mkdirSync(dataDir, { recursive: true });
  savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});
afterEach(() => {
  process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
  fake.remove();
});

function environment(extra: Record<string, string> = {}, platform: NodeJS.Platform = "linux"): AgentEnvironment {
  return createAgentEnvironmentFor({ platform, homeDir: fake.home, env: { ...fake.env, ...extra } });
}
const options = (extra: Record<string, string> = {}, dir = dataDir) => ({ dataDir: dir, selfCommand: SELF, environment: environment(extra) });
const qwenHome = () => join(fake.home, ".qwen");
/** The grants the fake qwen holds, with their tokens. */
const grants = (home = qwenHome()): { id: string; label: string; token: string }[] => {
  try {
    return (JSON.parse(readFileSync(join(home, "peer-controllers.json"), "utf8")) as { controllers: { id: string; label: string; token: string }[] }).controllers;
  } catch {
    return [];
  }
};
const controllerCalls = (sub: string) => fake.calls().filter((call) => call.name === "qwen" && call.args[0] === "sessions" && call.args[2] === sub);
/** The person runs `qwen sessions controllers remove <every id>`. */
const revokeAllInQwen = (home = qwenHome()) => writeFileSync(join(home, "peer-controllers.json"), JSON.stringify({ schemaVersion: 1, controllers: [] }));

describe("Qwen Code's trusted sender", () => {
  test("only Qwen Code 0.24 or later has trusted senders (nightlies count)", () => {
    expect(qwenHasTrust(parseQwenVersion("0.24.0\n"))).toBe(true);
    expect(qwenHasTrust(parseQwenVersion("0.27.0-nightly.20261020.abc"))).toBe(true);
    expect(qwenHasTrust(parseQwenVersion("0.23.9"))).toBe(false);
    expect(qwenHasTrust(parseQwenVersion("qwen 1.0"))).toBe(false);
  });

  test("connecting Qwen Code mints one token under this data dir's label, kept 0600 for this Qwen home, said in the band and the terminal; the next run keeps it", async () => {
    fake.install("qwen");
    const report = await connectInboxAgents(options());
    expect(report.added).toEqual(["qwen"]);
    expect(report.trusted).toEqual(["qwen"]);
    expect(controllerCalls("add").map((call) => call.args)).toEqual([["sessions", "controllers", "add", "--label", qwenTrustLabel(dataDir), "--json"]]);
    const [grant] = grants();
    const file = readQwenTrust(dataDir)!;
    expect(file).toMatchObject({ home: qwenHome(), id: grant!.id, token: grant!.token, label: qwenTrustLabel(dataDir) });
    expect(statSync(qwenTrustPath(dataDir)).mode & 0o777).toBe(0o600);
    expect(qwenWakeToken(dataDir, qwenHome())).toBe(grant!.token);
    // Never presented to another Qwen home.
    expect(qwenWakeToken(dataDir, join(fake.root, "other-qwen"))).toBeNull();
    // How far it reaches, and how to undo it.
    const said = formatConnectReport(report).join("\n");
    expect(said).toContain("any running Qwen Code session");
    expect(said).toContain("Settings → Agents");

    const again = await connectInboxAgents(options());
    expect(again.trusted ?? []).toEqual([]);
    expect(controllerCalls("add")).toHaveLength(1);
    expect(grants()).toHaveLength(1);
    expect(readQwenTrust(dataDir)!.token).toBe(grant!.token);
  });

  test("Qwen Code before 0.24: connected, no token, nothing minted", async () => {
    fake.install("qwen");
    const report = await connectInboxAgents(options({ FAKE_QWEN_VERSION: "0.23.0" }));
    expect(report.added).toEqual(["qwen"]);
    expect(report.trusted ?? []).toEqual([]);
    expect(controllerCalls("add")).toEqual([]);
    expect(existsSync(qwenTrustPath(dataDir))).toBe(false);
  });

  test("Windows (no socket to wake a Qwen session): no token minted, nothing claimed", async () => {
    fake.install("qwen");
    const report = await connectInboxAgents({ dataDir, selfCommand: SELF, environment: environment({}, "win32") });
    expect(report.added).toEqual(["qwen"]);
    expect(report.trusted ?? []).toEqual([]);
    expect(controllerCalls("add")).toEqual([]);
    expect(existsSync(qwenTrustPath(dataDir))).toBe(false);
    expect(await setInboxAgentReach("qwen", true, { dataDir, selfCommand: SELF, environment: environment({}, "win32") })).toBeNull();
    expect(controllerCalls("add")).toEqual([]);
  });

  test("a grant the person revoked in Qwen is said once, never minted again by itself; turning Qwen Code off and on in Settings mints a new one", async () => {
    fake.install("qwen");
    await connectInboxAgents(options());
    revokeAllInQwen();
    const seen = await connectInboxAgents(options());
    expect(seen.trust_failed).toEqual([{ agent: "qwen", reason: QWEN_TRUST_REVOKED_REASON }]);
    expect(readInboxAgents(dataDir).last_report?.trust_failed).toEqual([{ agent: "qwen", reason: QWEN_TRUST_REVOKED_REASON }]);
    expect(controllerCalls("add")).toHaveLength(1);
    expect(readQwenTrust(dataDir)).toMatchObject({ revoked_outside_at: expect.any(String) });
    expect(qwenWakeToken(dataDir, qwenHome())).toBeNull();
    const later = await connectInboxAgents(options());
    expect(later.trust_failed ?? []).toEqual([]);
    expect(controllerCalls("add")).toHaveLength(1);

    expect(await setInboxAgentReach("qwen", false, options())).toBeNull();
    expect(await setInboxAgentReach("qwen", true, options())).toBeNull();
    expect(controllerCalls("add")).toHaveLength(2);
    expect(qwenWakeToken(dataDir, qwenHome())).toBe(grants()[0]!.token);
  });

  test("a grant revoked while the Inbox runs (the wake asks when Qwen stops confirming): the token is dropped, and the next run says so once", async () => {
    fake.install("qwen");
    await connectInboxAgents(options());
    expect(await checkQwenTrust(dataDir, environment())).toBe("listed");
    revokeAllInQwen();
    expect(await checkQwenTrust(dataDir, environment())).toBe("gone");
    expect(qwenWakeToken(dataDir, qwenHome())).toBeNull();
    const next = await connectInboxAgents(options());
    expect(next.trust_failed).toEqual([{ agent: "qwen", reason: QWEN_TRUST_REVOKED_REASON }]);
    expect((await connectInboxAgents(options())).trust_failed ?? []).toEqual([]);
    expect(controllerCalls("add")).toHaveLength(1);
  });

  test("turning Qwen Code off in Settings removes the entry, then revokes the token in Qwen and forgets it", async () => {
    fake.install("qwen");
    await connectInboxAgents(options());
    const { id } = readQwenTrust(dataDir)!;
    expect(await setInboxAgentReach("qwen", false, options())).toBeNull();
    expect(controllerCalls("remove").map((call) => call.args)).toEqual([["sessions", "controllers", "remove", id!]]);
    expect(grants()).toEqual([]);
    expect(existsSync(qwenTrustPath(dataDir))).toBe(false);
    // Off stays off: the next run neither connects nor mints.
    await connectInboxAgents(options());
    expect(controllerCalls("add")).toHaveLength(1);
  });

  test.skipIf(process.getuid?.() === 0)("an entry that cannot be removed keeps Qwen Code on with its token, and no later run mints a second one", async () => {
    fake.install("qwen");
    await connectInboxAgents(options());
    const { token } = readQwenTrust(dataDir)!;
    const settings = join(qwenHome(), "settings.json");
    chmodSync(settings, 0o444);
    try {
      expect(await setInboxAgentReach("qwen", false, options())).toContain("read-only");
      expect(controllerCalls("remove")).toEqual([]);
      expect(readQwenTrust(dataDir)!.token).toBe(token);
      await connectInboxAgents(options());
      expect(controllerCalls("add")).toHaveLength(1);
      expect(grants()).toHaveLength(1);
    } finally {
      chmodSync(settings, 0o644);
    }
  });

  test("a grant Qwen will not revoke: Qwen Code is still off, the token is never presented again, and each later run tries the revoke until it works", async () => {
    fake.install("qwen");
    await connectInboxAgents(options());
    const { id } = readQwenTrust(dataDir)!;
    const problem = await setInboxAgentReach("qwen", false, options({ FAKE_QWEN_CONTROLLERS_FAIL: "1" }));
    expect(problem).toContain(`qwen sessions controllers remove ${id}`);
    expect(problem).toContain("tries again at the next start");
    expect(readInboxAgents(dataDir).agents.qwen?.state).toBe("off");
    expect(grants()).toHaveLength(1);
    // Off means off: the wake has no token now (its only source), and none is on disk.
    expect(qwenWakeToken(dataDir, qwenHome())).toBeNull();
    expect(readFileSync(qwenTrustPath(dataDir), "utf8")).not.toContain(grants()[0]!.token);
    expect(readQwenTrust(dataDir)).toMatchObject({ id, revoke_pending: true });
    // A run while Qwen still refuses: said once, nothing minted.
    const refused = await connectInboxAgents(options({ FAKE_QWEN_CONTROLLERS_FAIL: "1" }));
    expect(refused.trust_failed?.[0]?.reason).toContain(`qwen sessions controllers remove ${id}`);
    expect((await connectInboxAgents(options({ FAKE_QWEN_CONTROLLERS_FAIL: "1" }))).trust_failed ?? []).toEqual([]);
    // The next run Qwen allows it: revoked, forgotten, and still nothing minted.
    await connectInboxAgents(options());
    expect(grants()).toEqual([]);
    expect(existsSync(qwenTrustPath(dataDir))).toBe(false);
    expect(controllerCalls("add")).toHaveLength(1);
  });

  test("a grant waiting to be revoked is revoked before a new one is minted when Qwen Code is turned on again; uninstall revokes it too", async () => {
    fake.install("qwen");
    await connectInboxAgents(options());
    const first = readQwenTrust(dataDir)!.id!;
    await setInboxAgentReach("qwen", false, options({ FAKE_QWEN_CONTROLLERS_FAIL: "1" }));
    expect(await setInboxAgentReach("qwen", true, options())).toBeNull();
    expect(controllerCalls("remove").map((call) => call.args[3])).toContain(first);
    expect(grants()).toHaveLength(1);
    expect(grants()[0]!.id).not.toBe(first);
    expect(qwenWakeToken(dataDir, qwenHome())).toBe(grants()[0]!.token);

    await setInboxAgentReach("qwen", false, options({ FAKE_QWEN_CONTROLLERS_FAIL: "1" }));
    const removal = qwenTrustRemoval(dataDir, environment())!;
    expect(removal.describe).toContain(grants()[0]!.id);
    expect(await removal.apply()).toEqual({ kind: "revoked" });
    expect(grants()).toEqual([]);
  });

  test("a grant list of another shape (a future Qwen's array, a message line) is unknown: the token is kept, never called revoked", async () => {
    fake.install("qwen");
    await connectInboxAgents(options());
    const { token, id } = readQwenTrust(dataDir)!;
    for (const output of [`${JSON.stringify([{ id, label: qwenTrustLabel(dataDir) }])}\n`, '{"message":"No controllers."}\n', "null\n"]) {
      const env = { FAKE_QWEN_LIST_OUTPUT: output };
      expect((await connectInboxAgents(options(env))).trust_failed ?? []).toEqual([]);
      expect(await checkQwenTrust(dataDir, environment(env))).toBe("unknown");
      expect(readQwenTrust(dataDir)).toMatchObject({ token });
      expect(readQwenTrust(dataDir)!.revoked_outside_at).toBeUndefined();
    }
    expect(controllerCalls("add")).toHaveLength(1);
  });

  test("a mint that fails when the person turns Qwen Code on is said, Qwen Code still on", async () => {
    fake.install("qwen");
    const said = await setInboxAgentReach("qwen", true, options({ FAKE_QWEN_CONTROLLERS_FAIL: "1" }));
    expect(said).toContain("won't get your replies by itself");
    expect(readInboxAgents(dataDir).agents.qwen?.state).toBe("added");
    expect(qwenWakeToken(dataDir, qwenHome())).toBeNull();
  });

  test("QWEN_HOME changed: the grant is revoked in the old home and minted in the new; turning off later works too", async () => {
    fake.install("qwen");
    const other = join(fake.root, "other-qwen");
    await connectInboxAgents(options());
    expect(grants()).toHaveLength(1);
    expect((await ensureQwenTrust(dataDir, environment({ QWEN_HOME: other }))).kind).toBe("added");
    expect(grants()).toEqual([]);
    expect(grants(other)).toHaveLength(1);
    expect(readQwenTrust(dataDir)).toMatchObject({ home: other, token: grants(other)[0]!.token });

    // Turned off from an environment without QWEN_HOME: revoked where the grant is.
    expect(await setInboxAgentReach("qwen", false, options())).toBeNull();
    expect(grants(other)).toEqual([]);
    expect(existsSync(qwenTrustPath(dataDir))).toBe(false);
  });

  test("a grant Qwen has no more counts as revoked; with no qwen to run, the token is forgotten and the command said", async () => {
    fake.install("qwen");
    await connectInboxAgents(options());
    revokeAllInQwen();
    const removal = qwenTrustRemoval(dataDir, environment())!;
    expect(await removal.apply()).toEqual({ kind: "revoked" });
    expect(existsSync(qwenTrustPath(dataDir))).toBe(false);

    await setInboxAgentReach("qwen", true, options());
    const id = readQwenTrust(dataDir)!.id!;
    const noQwen = createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: { ...fake.env, PATH: join(fake.root, "empty") } });
    const said = await setInboxAgentReach("qwen", false, { dataDir, selfCommand: SELF, environment: noQwen });
    expect(said).toContain(`qwen sessions controllers remove ${id}`);
    expect(existsSync(qwenTrustPath(dataDir))).toBe(false);
    expect(readInboxAgents(dataDir).agents.qwen?.state).toBe("off");
  });

  test("uninstall revokes it (also when Plannotator only found Qwen's entry); without qwen it is forgotten and the command named", async () => {
    fake.install("qwen");
    await connectInboxAgents(options());
    const removal = qwenTrustRemoval(dataDir, environment())!;
    expect(removal.describe).toBe(`Plannotator's trusted-sender token in Qwen Code (qwen sessions controllers remove ${readQwenTrust(dataDir)!.id})`);
    expect(removal.runnable).toBe(true);
    // Not in the MCP removal plan: the token is its own item, never mistaken for the entry.
    expect(planInboxAgentRemoval(dataDir, environment(), OURS).items.map((item) => item.describe)).toEqual(["MCP server plannotator-inbox from Qwen Code (~/.qwen/settings.json, that entry only)"]);
    expect(await removal.apply()).toEqual({ kind: "revoked" });
    expect(grants()).toEqual([]);
    expect(qwenTrustRemoval(dataDir, environment())).toBeNull();

    await ensureQwenTrust(dataDir, environment());
    const noQwen = createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: { ...fake.env, PATH: join(fake.root, "empty") } });
    const manual = qwenTrustRemoval(dataDir, noQwen)!;
    expect(manual.runnable).toBe(false);
    expect(await manual.apply()).toEqual({ kind: "forgotten", manual: `qwen sessions controllers remove ${grants()[0]!.id}` });
    expect(grants()).toHaveLength(1);
    expect(existsSync(qwenTrustPath(dataDir))).toBe(false);
  });

  test("a grant under this data dir's label that it lost is revoked before a new one is minted: Qwen never keeps an orphan", async () => {
    fake.install("qwen");
    await connectInboxAgents(options());
    const orphan = grants()[0]!.id;
    writeFileSync(qwenTrustPath(dataDir), "{ broken");
    expect((await ensureQwenTrust(dataDir, environment())).kind).toBe("added");
    expect(controllerCalls("remove").map((call) => call.args[3])).toEqual([orphan]);
    expect(grants()).toHaveLength(1);
    expect(grants()[0]!.id).not.toBe(orphan);
    expect(readQwenTrust(dataDir)!.token).toBe(grants()[0]!.token);
  });

  test("two Plannotator data dirs on one Qwen home each keep their own grant: neither revokes the other's", async () => {
    fake.install("qwen");
    const second = join(fake.root, "data-2");
    mkdirSync(second, { recursive: true });
    expect(qwenTrustLabel(second)).not.toBe(qwenTrustLabel(dataDir));
    expect((await ensureQwenTrust(dataDir, environment())).kind).toBe("added");
    expect((await ensureQwenTrust(second, environment())).kind).toBe("added");
    expect(controllerCalls("remove")).toEqual([]);
    expect(grants().map((grant) => grant.label).sort()).toEqual([qwenTrustLabel(dataDir), qwenTrustLabel(second)].sort());
    // The first still holds a grant Qwen lists.
    expect((await ensureQwenTrust(dataDir, environment())).kind).toBe("kept");
    expect(qwenWakeToken(dataDir, qwenHome())).toBe(grants().find((grant) => grant.label === qwenTrustLabel(dataDir))!.token);
  });

  test("a failing mint leaves no token and no grant, is tried again next run, and is said once", async () => {
    fake.install("qwen");
    const first = await connectInboxAgents(options({ FAKE_QWEN_CONTROLLERS_FAIL: "1" }));
    expect(first.added).toEqual(["qwen"]);
    expect(first.trust_failed?.[0]?.reason).toContain("qwen sessions controllers");
    expect(qwenWakeToken(dataDir, qwenHome())).toBeNull();
    const second = await connectInboxAgents(options({ FAKE_QWEN_CONTROLLERS_FAIL: "1" }));
    expect(second.trust_failed ?? []).toEqual([]);
    const fixed = await connectInboxAgents(options());
    expect(fixed.trusted).toEqual(["qwen"]);
    expect(qwenWakeToken(dataDir, qwenHome())).toBe(grants()[0]!.token);
  });

  test("a run under another QWEN_HOME moves no grant: it stays with the entry; turning Qwen Code on in Settings there moves both", async () => {
    fake.install("qwen");
    const other = join(fake.root, "other-qwen");
    await connectInboxAgents(options());
    const { token } = readQwenTrust(dataDir)!;
    const run = await connectInboxAgents(options({ QWEN_HOME: other }));
    expect(run.trusted ?? []).toEqual([]);
    expect(run.trust_failed ?? []).toEqual([]);
    expect(controllerCalls("add")).toHaveLength(1);
    expect(controllerCalls("remove")).toEqual([]);
    expect(readQwenTrust(dataDir)).toMatchObject({ home: qwenHome(), token });
    expect(grants(other)).toEqual([]);

    expect(await setInboxAgentReach("qwen", true, options({ QWEN_HOME: other }))).toBeNull();
    expect(grants()).toEqual([]);
    expect(grants(other)).toHaveLength(1);
    expect(readQwenTrust(dataDir)).toMatchObject({ home: other, token: grants(other)[0]!.token });
    expect(JSON.parse(readFileSync(join(other, "settings.json"), "utf8")).mcpServers["plannotator-inbox"]).toBeDefined();
  });

  test("a grant waiting to be revoked in another Qwen home is revoked there: at the next run while off, and before a mint when turned on", async () => {
    fake.install("qwen");
    const other = join(fake.root, "other-qwen");
    // Turned off while Qwen refused: the grant in ~/.qwen waits to be revoked.
    await connectInboxAgents(options());
    await setInboxAgentReach("qwen", false, options({ FAKE_QWEN_CONTROLLERS_FAIL: "1" }));
    expect(readQwenTrust(dataDir)).toMatchObject({ home: qwenHome(), revoke_pending: true });
    // A run from a shell with another QWEN_HOME: revoked in the grant's own home.
    await connectInboxAgents(options({ QWEN_HOME: other }));
    expect(grants()).toEqual([]);
    expect(existsSync(qwenTrustPath(dataDir))).toBe(false);

    // Again, and this time turned on under the other home: the old one goes before the new one is minted.
    await setInboxAgentReach("qwen", true, options());
    await setInboxAgentReach("qwen", false, options({ FAKE_QWEN_CONTROLLERS_FAIL: "1" }));
    expect(grants()).toHaveLength(1);
    expect(await setInboxAgentReach("qwen", true, options({ QWEN_HOME: other }))).toBeNull();
    expect(grants()).toEqual([]);
    expect(grants(other)).toHaveLength(1);
    expect(qwenWakeToken(dataDir, other)).toBe(grants(other)[0]!.token);
  });

  test("the token leaves the data folder before Qwen is asked to revoke it (written ahead), so a stop mid-call never leaves it to present", async () => {
    fake.install("qwen");
    await connectInboxAgents(options());
    const { id, token } = readQwenTrust(dataDir)!;
    expect(await setInboxAgentReach("qwen", false, options({ FAKE_QWEN_CONTROLLERS_SEE: qwenTrustPath(dataDir) }))).toBeNull();
    const seen = readFileSync(`${qwenTrustPath(dataDir)}.remove.seen`, "utf8");
    expect(seen).not.toContain(token!);
    expect(JSON.parse(seen)).toMatchObject({ id, revoke_pending: true });
    expect(existsSync(qwenTrustPath(dataDir))).toBe(false);
  });

  test.skipIf(process.getuid?.() === 0)("a data folder that can't be written: revoking never throws, and says the token is still there", async () => {
    fake.install("qwen");
    await connectInboxAgents(options());
    const folder = join(qwenTrustPath(dataDir), "..");
    chmodSync(folder, 0o500);
    try {
      const result = await qwenTrustRemoval(dataDir, environment({ FAKE_QWEN_CONTROLLERS_FAIL: "1" }))!.apply();
      expect(result).toMatchObject({ kind: "failed", held: true });
    } finally {
      chmodSync(folder, 0o700);
    }
  });

  test("Settings keeps the agent's record before it asks qwen anything: on (added) and off (off), as the qwen call sees agents.json", async () => {
    fake.install("qwen");
    const agentsJson = join(dataDir, "inbox", "agents.json");
    await connectInboxAgents(options());
    expect(await setInboxAgentReach("qwen", false, options({ FAKE_QWEN_CONTROLLERS_SEE: agentsJson }))).toBeNull();
    expect(JSON.parse(readFileSync(`${agentsJson}.remove.seen`, "utf8")).agents.qwen.state).toBe("off");
    expect(await setInboxAgentReach("qwen", true, options({ FAKE_QWEN_CONTROLLERS_SEE: agentsJson }))).toBeNull();
    expect(JSON.parse(readFileSync(`${agentsJson}.add.seen`, "utf8")).agents.qwen.state).toBe("added");
  });

  test("one Qwen home spelled two ways (a symlink, a trailing slash) keeps its grant: never revoked and minted again, and its sessions are woken", async () => {
    fake.install("qwen");
    const real = join(fake.root, "real-qwen");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, qwenHome());
    await connectInboxAgents(options());
    const { token } = readQwenTrust(dataDir)!;
    for (const spelled of [`${qwenHome()}/`, real, `${real}/`]) {
      const run = await connectInboxAgents(options({ QWEN_HOME: spelled }));
      expect(run.trusted ?? []).toEqual([]);
      expect(qwenWakeToken(dataDir, spelled)).toBe(token!);
    }
    expect(controllerCalls("add")).toHaveLength(1);
    expect(controllerCalls("remove")).toEqual([]);
  });

  test("the revoke command names QWEN_HOME only for another home, never for this one spelled another way", async () => {
    fake.install("qwen");
    const real = join(fake.root, "real-qwen");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, qwenHome());
    await connectInboxAgents(options());
    const { id, home } = readQwenTrust(dataDir)!;
    for (const spelled of [`${qwenHome()}/`, real, `${real}/`]) {
      expect(qwenTrustRemoval(dataDir, environment({ QWEN_HOME: spelled }))!.manual).toBe(`qwen sessions controllers remove ${id}`);
    }
    expect(qwenTrustRemoval(dataDir, environment({ QWEN_HOME: join(fake.root, "other-qwen") }))!.manual).toBe(`QWEN_HOME=${home} qwen sessions controllers remove ${id}`);
  });

  test.if(!IGNORES_CASE)("on a case-sensitive volume (Linux), a home that differs only by case is another home: its grant is never taken for removed, and stays where it is", async () => {
    fake.install("qwen");
    const lower = join(fake.root, "qwen");
    const upper = join(fake.root, "Qwen");
    mkdirSync(lower);
    mkdirSync(upper);
    await connectInboxAgents(options({ QWEN_HOME: lower }));
    const before = readQwenTrust(dataDir)!;
    for (const platform of ["darwin", "linux"] as const) {
      const run = await connectInboxAgents({ dataDir, selfCommand: SELF, environment: environment({ QWEN_HOME: upper }, platform) });
      expect(run.trust_failed ?? []).toEqual([]);
      expect(formatConnectReport(run).join("\n")).not.toContain("removed");
    }
    expect(readQwenTrust(dataDir)).toEqual(before);
    expect(qwenWakeToken(dataDir, lower)).toBe(before.token!);
    expect(qwenWakeToken(dataDir, upper)).toBeNull();
    expect(grants(lower).map((grant) => grant.id)).toEqual([before.id!]);
  });

  test("PLANNOTATOR_INBOX_CONNECT=0 mints nothing", async () => {
    fake.install("qwen");
    await connectInboxAgents(options({ PLANNOTATOR_INBOX_CONNECT: "0" }));
    expect(controllerCalls("add")).toEqual([]);
    expect(existsSync(qwenTrustPath(dataDir))).toBe(false);
  });
});
