/**
 * Where this computer's Rex server listens (inbox-rex-where.ts), on any system Rex runs on. What this catches: a Linux
 * or FreeBSD server never found (the Mac app's folder looked for there), Rex's own overrides ignored, another
 * computer's address taken for a socket here, a Mac that starts looking somewhere new, and a socket of another
 * account's accepted when nobody named it. The sockets are a fake Rex's, in a temp folder.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startFakeRex, type FakeRex } from "../../tests/helpers/fake-rex";
import { createInboxRex, type InboxRex } from "./inbox-rex";
import { inboxRexHeadless, inboxRexServerSocket, inboxRexSocketPick, inboxRexSockets } from "./inbox-rex-where";

const paths = (...args: Parameters<typeof inboxRexSockets>) => inboxRexSockets(...args).map((socket) => socket.path);

describe("the places a Rex server may listen", () => {
  test("Linux: the account's runtime folder, as the session names it or by its usual path, then the state folder (machines without /run/user)", () => {
    expect(paths("linux", "/home/ada", { XDG_RUNTIME_DIR: "/run/user/1000" }, 1000)).toEqual(["/run/user/1000/rex/server.sock", "/home/ada/.local/state/rex/run/server.sock"]);
    // An Inbox started without a login session's env still looks in the usual folder.
    expect(paths("linux", "/home/ada", {}, 1000)).toEqual(["/run/user/1000/rex/server.sock", "/home/ada/.local/state/rex/run/server.sock"]);
    expect(paths("linux", "/home/ada", { XDG_RUNTIME_DIR: "/tmp/rt", XDG_STATE_HOME: "/data/state" }, 1000)).toEqual([
      "/tmp/rt/rex/server.sock",
      "/run/user/1000/rex/server.sock",
      "/data/state/rex/run/server.sock",
      "/home/ada/.local/state/rex/run/server.sock",
    ]);
  });

  test("FreeBSD has no /run/user: the state folder", () => {
    expect(paths("freebsd", "/home/ada", {}, 1001)).toEqual(["/home/ada/.local/state/rex/run/server.sock"]);
  });

  test("Rex's own overrides come first: the server the environment names, then REX_RUNTIME_DIR", () => {
    const found = inboxRexSockets("linux", "/home/ada", { REX_SERVER: "/run/rex/server.sock", REX_RUNTIME_DIR: "/srv/rex", XDG_RUNTIME_DIR: "/run/user/1000" }, 1000);
    expect(found.slice(0, 3)).toEqual([{ path: "/run/rex/server.sock", named: true }, { path: "/srv/rex/server.sock" }, { path: "/run/user/1000/rex/server.sock" }]);
    // The detached Inbox's own name for it wins over the one a pane it was started from may still carry.
    expect(paths("linux", "/home/ada", { PLANNOTATOR_INBOX_REX_SERVER: "/a/server.sock", REX_SERVER: "/b/server.sock" }, 1000)[0]).toBe("/a/server.sock");
  });

  test("REX_SERVER names a socket here only as a path: another computer's address or a host's label is never one", () => {
    expect(inboxRexServerSocket("/run/rex/server.sock")).toBe("/run/rex/server.sock");
    expect(inboxRexServerSocket("unix:///run/rex/server.sock")).toBe("/run/rex/server.sock");
    expect(inboxRexServerSocket("unix:/run/rex/server.sock")).toBe("/run/rex/server.sock");
    for (const elsewhere of ["https://build.example.ts.net", "http://10.0.0.5:7297", "ssh://ada@build.example.com", "build", "build.example.ts.net:7297", "relative/server.sock", "", undefined]) {
      expect(inboxRexServerSocket(elsewhere)).toBeNull();
    }
    expect(paths("linux", "/home/ada", { REX_SERVER: "ssh://ada@build.example.com" }, 1000)[0]).toBe("/run/user/1000/rex/server.sock");
  });

  test("REX_SERVER as Rex writes it in every tab (a percent-encoded URL) names the real path; a bad escape names nothing, and the next place is looked at", () => {
    const app = "/Users/ada/Library/Application Support/rex/server.sock";
    expect(inboxRexServerSocket("unix:///Users/ada/Library/Application%20Support/rex/server.sock")).toBe(app);
    expect(inboxRexServerSocket("unix:/srv/my%20rex/server.sock")).toBe("/srv/my rex/server.sock");
    // A bare path is a path: a literal `%20` in a folder's name stays.
    expect(inboxRexServerSocket("/srv/100%20off/server.sock")).toBe("/srv/100%20off/server.sock");
    for (const bad of ["unix:///srv/rex%/server.sock", "unix:///srv/rex%zz/server.sock", "unix:///srv/rex%0A/server.sock", "unix:///srv/rex%00/server.sock"]) {
      expect(() => inboxRexServerSocket(bad)).not.toThrow();
      expect(inboxRexServerSocket(bad)).toBeNull();
    }
    expect(paths("linux", "/home/ada", { REX_SERVER: "unix:///srv/rex%/server.sock" }, 1000)[0]).toBe("/run/user/1000/rex/server.sock");
    // The detached Inbox's own name for it (the decoded path) is read as a path again, never decoded twice.
    expect(inboxRexSockets("linux", "/home/ada", { PLANNOTATOR_INBOX_REX_SERVER: inboxRexServerSocket("unix:///srv/a%2520b/server.sock")! }, 1000)[0]).toEqual({ path: "/srv/a%20b/server.sock", named: true });
  });

  test("which place is used: this user's own socket first, named or not, so a shared server named in the profile never hides the person's own server; else a named one of another account; never another account's found by convention", () => {
    const me = 1000;
    // Sockets that exist here, and whose they are.
    const owners = new Map([["/run/rex/server.sock", 0], ["/run/user/1000/rex/server.sock", me], ["/home/ada/.local/state/rex/run/server.sock", me], ["/tmp/other/server.sock", 1001]]);
    const isSocket = (at: string, uid: number | null) => owners.has(at) && (uid === null || owners.get(at) === uid);
    const shared = { path: "/run/rex/server.sock", named: true as const };
    const own = { path: "/run/user/1000/rex/server.sock" };
    expect(inboxRexSocketPick([shared, own], isSocket, me)).toBe(own.path);
    expect(inboxRexSocketPick([shared, { path: "/nothing/server.sock" }], isSocket, me)).toBe(shared.path);
    expect(inboxRexSocketPick([{ path: "/tmp/other/server.sock" }], isSocket, me)).toBeNull();
    // An own named one keeps its place before a later own one.
    expect(inboxRexSocketPick([{ path: own.path, named: true }, { path: "/home/ada/.local/state/rex/run/server.sock" }], isSocket, me)).toBe(own.path);
    // No uid known: the first socket at all, as listed.
    expect(inboxRexSocketPick([shared, own], isSocket, null)).toBe(shared.path);
  });

  test("a Mac with REX_SERVER or REX_RUNTIME_DIR set (an Inbox started from a Rex tab keeps them): the app's own server still comes first", () => {
    const app = "/Users/ada/Library/Application Support/rex/server.sock";
    expect(inboxRexSockets("darwin", "/Users/ada", { REX_SERVER: "/tmp/other/server.sock", REX_RUNTIME_DIR: "/tmp/rt" }, 501)).toEqual([{ path: app }, { path: "/tmp/other/server.sock", named: true }, { path: "/tmp/rt/server.sock" }]);
    expect(inboxRexSockets("darwin", "/Users/ada", { PLANNOTATOR_INBOX_REX_SERVER: app }, 501)).toEqual([{ path: app }]);
  });

  test("a Mac with nothing set looks only where it always did: the app's server", () => {
    expect(inboxRexSockets("darwin", "/Users/ada", { XDG_RUNTIME_DIR: "/ignored/there" }, 501)).toEqual([{ path: "/Users/ada/Library/Application Support/rex/server.sock" }]);
  });

  test("Windows: none (a named pipe)", () => {
    expect(inboxRexSockets("win32", "C:\\Users\\ada", { REX_SERVER: "/x/server.sock" }, null)).toEqual([]);
  });

  test("only a Mac has Rex's app beside its server", () => {
    expect(inboxRexHeadless("darwin")).toBe(false);
    expect(inboxRexHeadless("linux")).toBe(true);
    expect(inboxRexHeadless("freebsd")).toBe(true);
  });
});

describe("which of them is this computer's Rex", () => {
  const fakes: FakeRex[] = [];
  const rexes: InboxRex[] = [];
  afterEach(async () => {
    for (const rex of rexes.splice(0)) rex.close();
    for (const fake of fakes.splice(0)) await fake.stop();
  });
  const rexOn = (socketPath: Parameters<typeof createInboxRex>[0]["socketPath"], uid?: number) => {
    const rex = createInboxRex({ socketPath, headless: true, readTimeoutMs: 1_000, ...(uid !== undefined ? { uid } : {}) });
    rexes.push(rex);
    return rex;
  };

  test("the first that is a socket: a folder with no server in it is passed over", async () => {
    const fake = startFakeRex({ app: false });
    fakes.push(fake);
    const rex = rexOn([{ path: join(fake.socketPath, "..", "nothing-here.sock") }, { path: fake.socketPath }]);
    expect(await rex.appAttachedNow()).toBe(true);
    expect(rex.shared()).toBe(false);
    expect(fake.connections().opened).toBe(1);
  });

  test("another account's socket: never one found by convention; one that was named (a shared server) is read, and no agent is ever started on it", async () => {
    const fake = startFakeRex({ app: false });
    fakes.push(fake);
    const notMine = (process.getuid?.() ?? 501) + 1;
    expect(await rexOn([{ path: fake.socketPath }], notMine).appAttachedNow()).toBe(false);
    expect(fake.connections().opened).toBe(0);
    // Named: where an agent lives there is read.
    const shared = rexOn([{ path: fake.socketPath, named: true }], notMine);
    const ids = fake.addSession("team", "shell");
    const hints = new Map([["ses_1", { kind: "rex" as const, session: ids.session, block: ids.block }]]);
    shared.places(hints);
    await shared.settled();
    expect(shared.places(hints).get("ses_1")).toBe("Rex · team / shell");
    // But it is not "Rex here" for starting agents, and a start asks it nothing: the agent would run as that account.
    expect(await shared.appAttachedNow()).toBe(false);
    // Settings says why: another account's server answered (not "isn't running").
    expect(shared.shared()).toBe(true);
    const before = fake.calls.length;
    expect(await shared.open({ project: "billing-svc", projectKey: "prj_bill", tab: "Claude Code", command: "cd /work && exec claude" })).toEqual({ opened: false, sent: false, shared: true });
    expect(fake.calls.slice(before)).toEqual([]);
    expect(fake.sessions).toHaveLength(1);
  });
});
