/**
 * A PR command runner for tests: records every `gh` / `glab` command a review
 * server would run and answers each one as a CLI that is not signed in (exit
 * 1, nothing on stdout), so no test runs the real GitHub CLI. Install it with
 * the server's seam, `setPRCommandRuntimeForTests` (packages/server/pr.ts and
 * apps/pi-extension/server/pr.ts), inside a test, and put the real runner back
 * in afterEach.
 *
 * `answer` overrides the reply for a command, e.g. a canned `gh api user`.
 */
import type { CommandResult, PRRuntime } from "../../packages/shared/pr-types";

export interface FakePRCommand {
  cmd: string;
  args: string[];
  input?: string;
}

export interface FakePRRuntime {
  runtime: PRRuntime;
  calls: FakePRCommand[];
}

const NOT_SIGNED_IN: CommandResult = {
  stdout: "",
  stderr: "fake PR runtime: not signed in (tests never run the real CLI)\n",
  exitCode: 1,
};

export function createFakePRRuntime(
  answer: (command: FakePRCommand) => CommandResult | undefined = () => undefined,
): FakePRRuntime {
  const calls: FakePRCommand[] = [];
  const reply = async (command: FakePRCommand): Promise<CommandResult> => {
    calls.push(command);
    return answer(command) ?? NOT_SIGNED_IN;
  };
  return {
    calls,
    runtime: {
      runCommand: (cmd, args) => reply({ cmd, args: [...args] }),
      runCommandWithInput: (cmd, args, input) => reply({ cmd, args: [...args], input }),
    },
  };
}
