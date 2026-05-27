import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  addProject,
  listProjects,
  readProjectRegistry,
  registerProject,
  removeProject,
} from "./project-registry";

describe("project-registry", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "plannotator-test-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("returns empty array when no registry exists", () => {
    expect(readProjectRegistry({ baseDir })).toEqual([]);
  });

  it("registers a project", () => {
    registerProject("test-project", "/tmp/test", { baseDir });
    const entries = readProjectRegistry({ baseDir });
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("test-project");
    expect(entries[0].cwd).toBe("/tmp/test");
  });

  it("upserts on same cwd, updating name", () => {
    registerProject("proj-old", "/path/a", { baseDir });
    registerProject("proj-new", "/path/a", { baseDir });
    const entries = readProjectRegistry({ baseDir });
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("proj-new");
    expect(entries[0].cwd).toBe("/path/a");
  });

  it("creates separate entries for same name, different cwd", () => {
    registerProject("proj", "/path/a", { baseDir });
    registerProject("proj", "/path/b", { baseDir });
    const entries = readProjectRegistry({ baseDir });
    expect(entries).toHaveLength(2);
  });

  it("removes a project by cwd", () => {
    registerProject("a", "/a", { baseDir });
    registerProject("b", "/b", { baseDir });
    expect(removeProject("/a", { baseDir })).toBe(true);
    expect(readProjectRegistry({ baseDir })).toHaveLength(1);
    expect(readProjectRegistry({ baseDir })[0].name).toBe("b");
  });

  it("returns false when removing nonexistent cwd", () => {
    expect(removeProject("/nope", { baseDir })).toBe(false);
  });

  it("lists sorted by lastSeen descending", async () => {
    registerProject("old", "/old", { baseDir });
    await new Promise((r) => setTimeout(r, 10));
    registerProject("new", "/new", { baseDir });
    const list = listProjects({ baseDir });
    expect(list[0].name).toBe("new");
    expect(list[1].name).toBe("old");
  });

  it("addProject throws on nonexistent path", () => {
    expect(() => addProject("/nonexistent/path/xyz", undefined, { baseDir })).toThrow(
      "Directory does not exist",
    );
  });

  it("addProject derives name from path", () => {
    const entry = addProject(baseDir, undefined, { baseDir });
    expect(entry.name).toBeTruthy();
    expect(entry.cwd).toBe(baseDir);
  });

  it("addProject uses provided name", () => {
    const entry = addProject(baseDir, "custom-name", { baseDir });
    expect(entry.name).toBe("custom-name");
  });
});
