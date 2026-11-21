import { afterEach, describe, expect, test } from "bun:test";
import type { InboxAttachmentState } from "@plannotator/core/inbox-types";
import { rememberMachine, resetMachineRoutes, setSelfMachine } from "./inboxUrl";
import { newTabUrl, openInMenu, openInMenuFor } from "./openIn";

describe("openInMenuFor", () => {
  test("installed JetBrains IDEs sit with the other editors, in catalog order", () => {
    const detected = [
      { id: "reveal", label: "Files", kind: "file-manager" as const, icon: "finder" },
      { id: "vscode", label: "VS Code", kind: "editor" as const, icon: "vscode" },
      { id: "webstorm", label: "WebStorm", kind: "editor" as const, icon: "jetbrains-ws" },
      { id: "rider", label: "Rider", kind: "editor" as const, icon: "jetbrains-rd" },
    ];
    const menu = openInMenuFor(
      { kind: "code", path: "src/retry.ts" },
      detected,
      "linux",
      null,
      null,
      false,
    );
    expect(menu.items.map((item) => item.id)).toEqual(["vscode", "webstorm", "rider", "reveal"]);
    expect(menu.items.filter((item) => item.kind === "app" && item.icon.startsWith("jetbrains-")).map((item) => item.label)).toEqual([
      "WebStorm",
      "Rider",
    ]);
  });
});

/** A linked machine's thread on screen (inbox-machines.md): its files are on that machine's disk, not this one's. */
describe("openInMenu and newTabUrl for a file on another machine", () => {
  const SELF = "ibx_01K7SSSSSSSSSSSSSSSSSSSSSS";
  const OTHER = "ibx_01K7MMMMMMMMMMMMMMMMMMMMMM";
  const detected = [
    { id: "vscode", label: "VS Code", kind: "editor" as const, icon: "vscode" },
    { id: "reveal", label: "Finder", kind: "file-manager" as const, icon: "finder" },
  ];
  const file = (id: string, name: string, kind: string): InboxAttachmentState => ({
    id,
    name,
    path: `/work/shop/${name}`,
    kind: kind as InboxAttachmentState["kind"],
    named_path: null,
    sent_sha256: "a".repeat(64),
    size: 1000,
    sent_at: "2026-10-10T10:42:00.000Z",
    sent_mtime: "2026-10-10T10:42:00.000Z",
    message_id: "msg_01K7M1MMMMMMMMMMMMMMMMMMMM",
    changed_since_sent: false,
    unavailable: null,
    current: { sha256: "a".repeat(64), size: 1000, mtime: "2026-10-10T10:42:00.000Z" },
  });
  const page = file("att_01K7BBBBBBBBBBBBBBBBBBBBBB", "checkout.html", "html");
  const plan = file("att_01K7AAAAAAAAAAAAAAAAAAAAAA", "plan.md", "markdown");
  const shot = file("att_01K7CCCCCCCCCCCCCCCCCCCCCC", "shot.png", "image");

  afterEach(() => resetMachineRoutes());

  test("this computer's file: the list is unchanged, item by item, and a page and an image open in a new tab", () => {
    setSelfMachine(SELF);
    expect(openInMenu(page, detected, "mac", null, "current")).toEqual({
      items: [
        { kind: "browser", id: "browser", label: "Browser", href: `/api/inbox/attachments/${page.id}/page` },
        { kind: "app", id: "vscode", label: "VS Code", icon: "vscode" },
        { kind: "app", id: "reveal", label: "Finder", icon: "finder" },
      ],
      primary: { kind: "browser", id: "browser", label: "Browser", href: `/api/inbox/attachments/${page.id}/page` },
      missing: false,
    });
    expect(openInMenu(plan, detected, "mac", null, "current")).toEqual({
      items: [
        { kind: "app", id: "vscode", label: "VS Code", icon: "vscode" },
        { kind: "default", id: "default", label: "Default app" },
        { kind: "app", id: "reveal", label: "Finder", icon: "finder" },
      ],
      primary: { kind: "app", id: "vscode", label: "VS Code", icon: "vscode" },
      missing: false,
    });
    expect(openInMenu(shot, detected, "mac", null, "current")).toEqual({
      items: [
        { kind: "default", id: "default", label: "Default app" },
        { kind: "app", id: "reveal", label: "Finder", icon: "finder" },
      ],
      primary: { kind: "default", id: "default", label: "Default app" },
      missing: false,
    });
    expect(newTabUrl(page, "sent")).toBe(`/api/inbox/attachments/${page.id}/page?version=sent`);
    expect(newTabUrl(shot, "current")).toBe(`/api/inbox/attachments/${shot.id}/image`);
    expect(newTabUrl(plan, "current")).toBeNull();
  });

  test("another machine's file: no editors, no Default app, no Finder; a page and an image open in a new tab through the forward (Copy path ends every list)", () => {
    setSelfMachine(SELF);
    rememberMachine([page.id, plan.id, shot.id], OTHER);
    // The editors, Default app and Finder would launch on this computer, which does not have the file. Pinned item by
    // item: an empty list still shows Copy path (OpenInMenuItems adds it).
    const pageTab = { kind: "browser" as const, id: "browser" as const, label: "Browser", href: `/api/inbox/m/${OTHER}/attachments/${page.id}/page` };
    expect(openInMenu(page, detected, "mac", null, "current")).toEqual({ items: [pageTab], primary: pageTab, missing: false });
    const sentTab = { ...pageTab, href: `${pageTab.href}?version=sent` };
    expect(openInMenu(page, detected, "mac", null, "sent")).toEqual({ items: [sentTab], primary: sentTab, missing: false });
    expect(openInMenu(plan, detected, "mac", null, "current")).toEqual({ items: [], primary: null, missing: false });
    const shotTab = { kind: "browser" as const, id: "browser" as const, label: "Browser", href: `/api/inbox/m/${OTHER}/attachments/${shot.id}/image` };
    expect(openInMenu(shot, detected, "mac", null, "current")).toEqual({ items: [shotTab], primary: shotTab, missing: false });
    // From the tailnet's icon too.
    expect(newTabUrl(page, "current")).toBe(pageTab.href);
    expect(newTabUrl(page, "sent")).toBe(sentTab.href);
    expect(newTabUrl(shot, "current")).toBe(shotTab.href);
    expect(newTabUrl(plan, "current")).toBeNull();
  });
});
