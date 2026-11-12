import { LiveProxyPortError } from "@plannotator/shared/live-proxy-port";
import { PortInUseError } from "@plannotator/server/remote";

export function exitOnPortInUse<A extends unknown[], R>(
  start: (...args: A) => Promise<R>,
  exit: (message: string) => never,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    try {
      return await start(...args);
    } catch (error) {
      if (error instanceof LiveProxyPortError) exit(error.message);
      if (error instanceof PortInUseError) exit(error.cliMessage);
      throw error;
    }
  };
}
