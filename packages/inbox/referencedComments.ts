/**
 * Comments made on a file an agent's message names (approval "inbox-file-refs-open-viewer"), before it is one of the
 * message's attachments. The first attaches the file; then each comment is kept there, in the order made, and the
 * attachment opens at the first. One made while that runs waits its turn: it is never dropped, and its promise says
 * whether it was kept. A failure keeps every comment not yet kept (`failed` hands them back with the reason), and
 * `retry` goes on from there: the file is attached once.
 */
export interface ReferencedCommentSteps {
  /** Attach the file to its message: the attachment's id. */
  attach: () => Promise<string>;
  /** Keep one comment on the attachment: the record's id. */
  save: (attachmentId: string, annotation: object) => Promise<string>;
  /** Every comment is kept: open the attachment at the first. */
  done: (attachmentId: string, first: string | null) => Promise<void> | void;
  /** Some were not kept: the reason, and those comments (their words stay on screen). */
  failed: (cause: unknown, unsaved: object[]) => void;
}

export interface ReferencedCommentQueue {
  add: (annotation: object) => Promise<boolean>;
  retry: () => Promise<boolean>;
}

export function referencedCommentQueue(steps: ReferencedCommentSteps): ReferencedCommentQueue {
  const waiting: object[] = [];
  let attached: string | null = null;
  let first: string | null = null;
  let running: Promise<boolean> | null = null;
  const run = (): Promise<boolean> => {
    if (running) return running;
    running = (async () => {
      try {
        attached ??= await steps.attach();
        while (waiting.length > 0) {
          const id = await steps.save(attached, waiting[0]!);
          waiting.shift();
          first ??= id;
        }
        await steps.done(attached, first);
        return true;
      } catch (cause) {
        steps.failed(cause, [...waiting]);
        return false;
      } finally {
        running = null;
      }
    })();
    return running;
  };
  return {
    add: (annotation) => {
      waiting.push(annotation);
      return run();
    },
    retry: run,
  };
}
