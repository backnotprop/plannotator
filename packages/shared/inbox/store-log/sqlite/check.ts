/// <reference types="bun-types" />
/**
 * The move's check, both ways (`import.ts`, `return-to-files.ts`): open the store over each side and compare one
 * SHA-256 of everything it serves (`digest.ts`). Each store opens over a scratch data dir, so its start writes
 * nothing beside the person's records (a start prunes pins and snoozes of threads it does not hold: a side that
 * reads wrong must not take them with it); only the record log points at the real files. Every database a side
 * opened is closed before this returns, so the file can be renamed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxDir } from "../../schema";
import { InboxStore } from "../../store";
import type { InboxLog } from "../log";
import { inboxStoreDigest, type InboxStoreDigest } from "./digest";

/** One side of the check: the log the store reads (`dir` is the real inbox folder). */
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

function digestOf(dataDir: string, now: () => Date, side: InboxCheckSide): InboxStoreDigest {
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
