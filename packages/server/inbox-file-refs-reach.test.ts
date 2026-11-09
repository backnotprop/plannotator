/**
 * Who reaches a file an agent's message names on another machine, and which paths are never touched (approval
 * "inbox-file-refs-open-viewer"): the forward's refusal, the door's machine-only route, network paths and devices.
 * Pure: no Inbox, no server, no network; files are fixtures in a temp folder.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkInboxReadableFile } from "@plannotator/shared/inbox/attachments";
import { isNetworkPath } from "@plannotator/shared/inbox/network-paths";
import { doorRouteOf } from "./inbox-devices";
import { forwardedFileReadRefusal } from "./inbox-machines";
import { isPlannotatorState } from "./inbox-open-in";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const windowGet = (headers: Record<string, string> = {}) => new Request("http://127.0.0.1:4000/api/inbox/m/x/open-in/file/view", { headers: { host: "127.0.0.1:4000", ...headers } });

describe("a file read forwarded to a linked machine", () => {
  test("a tailnet guest is refused, even from a window: that machine would read it as its owner's", () => {
    expect(forwardedFileReadRefusal("open-in/file/view", windowGet({ "sec-fetch-site": "same-origin" }), true)).toMatchObject({ status: 403, body: { code: "owner_only" } });
    expect(forwardedFileReadRefusal("open-in/file/raw", windowGet({ "sec-fetch-site": "same-origin" }), true)).toMatchObject({ status: 403 });
  });

  test("only the owner's window reads it: a bare call (an agent, a script) and another page are refused", () => {
    expect(forwardedFileReadRefusal("open-in/file/view", windowGet({ "sec-fetch-site": "same-origin" }), false)).toBeNull();
    expect(forwardedFileReadRefusal("open-in/file/raw", windowGet({ "sec-fetch-site": "same-origin", origin: "http://127.0.0.1:4000" }), false)).toBeNull();
    expect(forwardedFileReadRefusal("open-in/file/view", windowGet(), false)).toMatchObject({ status: 403, body: { code: "window_only" } });
    expect(forwardedFileReadRefusal("open-in/file/view", windowGet({ "sec-fetch-site": "same-site" }), false)).toMatchObject({ status: 403 });
    expect(forwardedFileReadRefusal("open-in/file/view", windowGet({ "sec-fetch-site": "same-origin", origin: "http://evil.test" }), false)).toMatchObject({ status: 403 });
  });

  test("other forwarded reads are not this rule's", () => {
    expect(forwardedFileReadRefusal("threads", windowGet(), true)).toBeNull();
  });

  test("the door takes the file routes from a linked machine only; a phone gets none", () => {
    expect(doorRouteOf("GET", "open-in/file/view", true)?.windowPath).toBe("/api/inbox/open-in/file/view");
    expect(doorRouteOf("GET", "open-in/file/raw", true)?.windowPath).toBe("/api/inbox/open-in/file/raw");
    expect(doorRouteOf("GET", "open-in/file/view", false)).toBeNull();
    expect(doorRouteOf("GET", "open-in/file/raw", false)).toBeNull();
    expect(doorRouteOf("POST", "open-in/file/attach", true)).toBeNull();
  });
});

describe("paths on another computer", () => {
  test("UNC paths, in either slash, and macOS's mount-on-touch folders", () => {
    for (const path of ["//host/share/x.md", "\\\\host\\share\\x.md", "\\\\?\\C:\\x.md", "\\\\.\\pipe\\x"]) expect([path, isNetworkPath(path, "win32")]).toEqual([path, true]);
    expect(isNetworkPath("//host/share/x.md", "linux")).toBe(true);
    expect(isNetworkPath("/net/10.255.255.1/x.md", "darwin")).toBe(true);
    expect(isNetworkPath("/Network/Servers/nas/x.md", "darwin")).toBe(true);
    expect(isNetworkPath("/Users/me/notes.md", "darwin")).toBe(false);
  });

  test("a share the person already mounted reads like any folder: a Mac's SMB volume, WSL's Windows drive, an NFS home", () => {
    expect(isNetworkPath("/Volumes/Team Files/plan.md", "darwin")).toBe(false);
    expect(isNetworkPath("/mnt/c/Users/me/plan.md", "linux")).toBe(false);
    expect(isNetworkPath("/home/me/plan.md", "linux")).toBe(false);
  });

  test("checkInboxReadableFile refuses one before it is touched, and reads a local file", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-reach-")));
    roots.push(root);
    writeFileSync(join(root, "a.md"), "# A\n");
    expect(await checkInboxReadableFile(["//host/share/a.md"], () => false, { platform: "linux" })).toEqual({ ok: false, code: "refused" });
    expect(await checkInboxReadableFile(["/net/10.255.255.1/a.md"], () => false, { platform: "darwin" })).toEqual({ ok: false, code: "refused" });
    expect(await checkInboxReadableFile([join(root, "a.md")], () => false, { platform: "linux" })).toMatchObject({ ok: true, kind: "markdown" });
  });
});

describe("devices, pipes and live system files", () => {
  test("a FIFO is no file (and never blocks); /dev is refused by the view's rule", async () => {
    if (process.platform === "win32") return;
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-reach-")));
    roots.push(root);
    const fifo = join(root, "pipe.log");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    expect(await checkInboxReadableFile([fifo], () => false)).toEqual({ ok: false, code: "missing" });
    const system = (path: string) => /^\/(?:proc|sys|dev)(?:\/|$)/.test(path);
    expect(await checkInboxReadableFile(["/dev/null"], system)).toEqual({ ok: false, code: "refused" });
    expect(await checkInboxReadableFile(["/dev/zero"], () => false)).toEqual({ ok: false, code: "missing" });
  });

  test("a kept handle reads the file that was checked", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-reach-")));
    roots.push(root);
    writeFileSync(join(root, "a.log"), "one\ntwo\n");
    const file = await checkInboxReadableFile([join(root, "a.log")], () => false, { keep: true });
    if (!file.ok) throw new Error("expected a file");
    try {
      expect((await file.handle!.readFile("utf8"))).toBe("one\ntwo\n");
    } finally {
      await file.handle!.close();
    }
  });
});

describe("Plannotator's own state", () => {
  test("everything in the data folder but its documents, without case", () => {
    const dirs = ["/u/me/.plannotator", "/data/pl"];
    for (const path of ["/u/me/.plannotator/inbox/machines.json", "/u/me/.plannotator/inbox/device-secrets/d1", "/data/pl/inbox/relay.json", "/data/pl/config.json", "/U/Me/.Plannotator/Inbox/inbox.json", "/data/pl/agents-home/x/.claude.json"]) {
      expect([path, isPlannotatorState(path, dirs)]).toEqual([path, true]);
    }
    for (const path of ["/u/me/.plannotator/plans/p.md", "/data/pl/history/h.md", "/u/me/.plannotatorx/inbox/a.json", "/u/me/notes.md"]) expect([path, isPlannotatorState(path, dirs)]).toEqual([path, false]);
  });
});
