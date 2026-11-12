/**
 * Test-only: a log that writes every change to two logs (today's first, so a refusal there writes nothing to
 * the other) and reads from the first, so a store written once leaves the same records, with the same ids, in
 * both. The every-read test and the SQLite tables test open each on its own afterwards.
 */
import type { InboxLog, InboxLogFactory } from "./log";

export function teeLog(first: InboxLogFactory, second: InboxLogFactory): InboxLogFactory {
  return (dir) => {
    const a = first(dir);
    const b = second(dir);
    const both: InboxLog = {
      read: () => a.read(),
      append: (line, project) => {
        a.append(line, project);
        b.append(line, project);
      },
      keyTaken: (key) => a.keyTaken(key) || b.keyTaken(key),
      createProject: (project, line) => {
        a.createProject(project, line);
        b.createProject(project, line);
      },
      deleteThread: (project, threadId, messageIds, seq) => {
        a.deleteThread(project, threadId, messageIds, seq);
        b.deleteThread(project, threadId, messageIds, seq);
      },
      deleteProject: (project, seq) => {
        a.deleteProject(project, seq);
        b.deleteProject(project, seq);
      },
      cardLines: (project, cardId) => a.cardLines(project, cardId),
      usage: (project) => a.usage(project),
    };
    return both;
  };
}
