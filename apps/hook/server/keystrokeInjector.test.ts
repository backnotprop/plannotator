import {
  describe,
  it,
  expect,
  spyOn,
  mock,
  beforeEach,
  afterEach,
} from "bun:test";
import { spawnKeystrokeInjector } from "./keystrokeInjector";

describe("spawnKeystrokeInjector", () => {
  let spawnCalls: { cmd: string[]; opts: Record<string, unknown> }[] = [];
  let originalEnv: NodeJS.ProcessEnv;
  let originalPlatform: string;

  function setPlatform(v: string) {
    Object.defineProperty(process, "platform", { value: v, writable: true });
  }

  beforeEach(() => {
    spawnCalls = [];
    originalEnv = { ...process.env };
    originalPlatform = process.platform;
    delete process.env["TMUX_PANE"];

    const mockChild = { unref: mock(() => {}) };
    spyOn(Bun, "spawn").mockImplementation(
      (cmd: string[], opts: Record<string, unknown>) => {
        spawnCalls.push({ cmd, opts });
        return mockChild as ReturnType<typeof Bun.spawn>;
      },
    );
  });

  afterEach(() => {
    process.env = originalEnv;
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      writable: true,
    });
    mock.restore();
  });

  it("uses tmux send-keys when TMUX_PANE is set", () => {
    process.env["TMUX_PANE"] = "%3";
    spawnKeystrokeInjector(100);

    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].cmd[0]).toBe("bash");
    const script = spawnCalls[0].cmd[2] as string;
    expect(script).toContain("tmux send-keys");
    expect(script).toContain("%3");
    expect(script).toContain("1 Enter");
    expect(script).not.toContain("osascript");
  });

  it("uses osascript on macOS when no tmux pane", () => {
    setPlatform("darwin");
    spawnKeystrokeInjector(100);

    expect(spawnCalls).toHaveLength(1);
    const script = spawnCalls[0].cmd[2] as string;
    expect(script).toContain("osascript");
    expect(script).toContain("warp");
    expect(script).toContain("iTerm2");
    expect(script).toContain("Terminal");
    expect(script).toContain('keystroke "1"');
    expect(script).not.toContain("tmux send-keys");
  });

  it("no-op on linux without tmux", () => {
    setPlatform("linux");
    spawnKeystrokeInjector();
    expect(spawnCalls).toHaveLength(0);
  });

  it("no-op on windows without tmux", () => {
    setPlatform("win32");
    spawnKeystrokeInjector();
    expect(spawnCalls).toHaveLength(0);
  });

  it("spawn is detached and unreffed (does not block caller)", () => {
    setPlatform("darwin");
    spawnKeystrokeInjector();

    expect(spawnCalls).toHaveLength(1);
    const opts = spawnCalls[0].opts as { detached: boolean; stdio: string[] };
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toEqual(["ignore", "ignore", "ignore"]);
  });

  it("embeds delay in tmux script via sleep", () => {
    process.env["TMUX_PANE"] = "%0";
    spawnKeystrokeInjector(1200);
    const script = spawnCalls[0].cmd[2] as string;
    expect(script).toContain("sleep 1.20");
  });

  it("embeds delay in osascript via 'delay' statement", () => {
    setPlatform("darwin");
    spawnKeystrokeInjector(800);
    const script = spawnCalls[0].cmd[2] as string;
    expect(script).toContain("delay 0.80");
  });
});
