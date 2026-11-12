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
