import * as z from "zod";
import type { T3Rpc } from "./t3-client";

const projectsPage = z.object({ projects: z.array(z.object({ id: z.string(), workspaceRoot: z.string() })), nextCursor: z.number().nullable() });
const threadsPage = z.object({ threads: z.array(z.object({ threadId: z.string() })), nextCursor: z.number().nullable() });
const activityPage = z.object({
  thread: z.object({ threadId: z.string(), projectId: z.string(), worktreePath: z.string().nullable(), archived: z.boolean() }),
  items: z.array(z.object({ itemId: z.string(), sourceThreadId: z.string(), visibility: z.string(), status: z.string() })),
});

export interface HookThread { thread: string; cwd: string }

/** T3 preserves Claude's native tool-use ID in the public activity item ID. */
export function claudeToolItemId(toolId: string): string {
  if (!/^toolu_[A-Za-z0-9]+$/.test(toolId) || toolId.length > 256) throw new Error("Invalid Claude tool-call identity.");
  return `turn-item:provider:claudeAgent:native-item:${encodeURIComponent(toolId)}`;
}

export async function findHookThread(rpc: T3Rpc, toolId: string, signal?: AbortSignal): Promise<HookThread | undefined> {
  const itemId = claudeToolItemId(toolId);
  const matches: HookThread[] = [];
  let projectCursor: number | undefined;
  for (let projectPages = 0; projectPages < 100; projectPages++) {
    const projects = projectsPage.parse(await rpc.call("t3_project_list", { limit: 100, ...(projectCursor === undefined ? {} : { cursor: projectCursor }) }, signal));
    for (const project of projects.projects) {
      let threadCursor: number | undefined;
      for (let threadPages = 0; threadPages < 100; threadPages++) {
        const threads = threadsPage.parse(await rpc.call("t3_thread_list", {
          projectId: project.id, statuses: ["running", "waiting", "starting", "preparing", "queued"], includeSubagents: true, limit: 100,
          ...(threadCursor === undefined ? {} : { cursor: threadCursor }),
        }, signal));
        for (const candidate of threads.threads) {
          let raw: unknown;
          try { raw = await rpc.call("t3_thread_read", { threadId: candidate.threadId, view: "activity", itemId, limit: 1 }, signal); }
          catch (error) { if (signal?.aborted) throw error; continue; }
          const activity = activityPage.parse(raw);
          if (activity.thread.threadId !== candidate.threadId || activity.thread.projectId !== project.id || activity.thread.archived) continue;
          const ownsCall = activity.items.some((item) => item.itemId === itemId && item.sourceThreadId === candidate.threadId && item.visibility === "local" && item.status === "running");
          if (ownsCall) matches.push({ thread: candidate.threadId, cwd: activity.thread.worktreePath ?? project.workspaceRoot });
        }
        if (threads.nextCursor === null) break;
        if (threads.nextCursor === threadCursor || threadPages === 99) throw new Error("T3 thread discovery did not settle.");
        threadCursor = threads.nextCursor;
      }
    }
    if (projects.nextCursor === null) break;
    if (projects.nextCursor === projectCursor || projectPages === 99) throw new Error("T3 project discovery did not settle.");
    projectCursor = projects.nextCursor;
  }
  if (matches.length > 1) throw new Error("More than one T3 conversation owns this tool call; automatic connection was refused.");
  return matches[0];
}
