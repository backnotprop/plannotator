import { describe, expect, test } from "bun:test";

import { SingleFlight } from "./single-flight";

describe("SingleFlight", () => {
  test("shares concurrent work for the same key without caching the result", async () => {
    const singleFlight = new SingleFlight<number>();
    let resolve: ((value: number) => void) | undefined;
    let calls = 0;
    const operation = () => {
      calls += 1;
      return new Promise<number>((done) => {
        resolve = done;
      });
    };

    const first = singleFlight.run("snapshot-1", operation);
    const second = singleFlight.run("snapshot-1", operation);
    expect(calls).toBe(1);
    resolve?.(42);
    expect(await Promise.all([first, second])).toEqual([42, 42]);

    expect(await singleFlight.run("snapshot-1", async () => 7)).toBe(7);
    expect(calls).toBe(1);
  });

  test("starts a different key independently and does not clear newer work", async () => {
    const singleFlight = new SingleFlight<string>();
    let resolveOld: ((value: string) => void) | undefined;
    let resolveNew: ((value: string) => void) | undefined;

    const oldWork = singleFlight.run("old", () => new Promise((done) => {
      resolveOld = done;
    }));
    const newWork = singleFlight.run("new", () => new Promise((done) => {
      resolveNew = done;
    }));
    const joinedNewWork = singleFlight.run("new", async () => "unexpected");

    resolveOld?.("old result");
    expect(await oldWork).toBe("old result");
    resolveNew?.("new result");
    expect(await Promise.all([newWork, joinedNewWork])).toEqual(["new result", "new result"]);
  });

  test("retries after rejection or explicit clearing", async () => {
    const singleFlight = new SingleFlight<string>();
    await expect(singleFlight.run("snapshot", async () => {
      throw new Error("failed");
    })).rejects.toThrow("failed");
    expect(await singleFlight.run("snapshot", async () => "retried")).toBe("retried");

    let resolve: ((value: string) => void) | undefined;
    const oldWork = singleFlight.run("snapshot", () => new Promise((done) => {
      resolve = done;
    }));
    singleFlight.clear();
    expect(await singleFlight.run("snapshot", async () => "replacement")).toBe("replacement");
    resolve?.("old result");
    expect(await oldWork).toBe("old result");
  });
});
