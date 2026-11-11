/// <reference types="bun-types" />
/**
 * Compares the store as served over two logs. Each store opens over a scratch data dir because a start prunes
 * pins and snoozes of threads it does not hold: a side that reads wrong must not take them with it.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxDir } from "../../schema";
import { InboxStore } from "../../store";
import type { InboxLog } from "../log";
import { inboxStoreDigest, type InboxStoreDigest } from "./digest";

/** `dir` is the real inbox folder. */
export interface InboxCheckSide {
  log: (dir: string) => InboxLog;
}

export interface InboxCheck {
  same: boolean;
  a: InboxStoreDigest;
  b: InboxStoreDigest;
}

export function checkDigests(dataDir: string, now: () => Date, a: InboxCheckSide, b: InboxCheckSide, between?: () => void): InboxCheck {
  const left = digestOf(dataDir, now, a);
  between?.();
  const right = digestOf(dataDir, now, b);
  return { same: left.sha256 === right.sha256, a: left, b: right };
}

export function digestOf(dataDir: string, now: () => Date, side: InboxCheckSide): InboxStoreDigest {
  const scratch = mkdtempSync(join(tmpdir(), "plannotator-inbox-check-"));
  const real = inboxDir(dataDir);
  const opened: InboxLog[] = [];
  try {
    const store = InboxStore.open(scratch, {
      now,
      log: () => {
        const log = side.log(real);
        opened.push(log);
        return log;
      },
    });
    return inboxStoreDigest(store);
  } finally {
    for (const log of opened) (log as { close?: () => void }).close?.();
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** `PRAGMA integrity_check` of the database `file`: "ok", or what it found. */
export function integrityOf(file: string): string {
  const db = new Database(file, { readwrite: true, create: false, strict: true });
  try {
    // The import has the file open too: wait out its moment of setting up the write-ahead log.
    db.run("PRAGMA busy_timeout = 5000");
    return db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()?.integrity_check ?? "no answer";
  } finally {
    db.close();
  }
}
