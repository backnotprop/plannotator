/** Test-only: writes to both logs (the first first, so its refusal writes nothing to the other) and reads from the first. */
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
