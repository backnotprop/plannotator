import { PortInUseError } from "@plannotator/server/remote";

/**
 * Wrap a server start so an occupied port ends the CLI with one clean line
 * instead of an uncaught error and its stack trace. In remote mode the port is
 * fixed (19432 unless PLANNOTATOR_PORT says otherwise), so a second concurrent
 * session — easy to hit now that the Claude Code mod's servers outlive the
 * terminal — lands here. Any other error is rethrown untouched.
 */
export function exitOnPortInUse<A extends unknown[], R>(
  start: (...args: A) => Promise<R>,
  exit: (message: string) => never,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    try {
      return await start(...args);
    } catch (error) {
      if (error instanceof PortInUseError) exit(error.cliMessage);
      throw error;
    }
  };
}
