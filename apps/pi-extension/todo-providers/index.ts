import { type PlannotatorConfig, resolveTodoProviderEnabled } from "../generated/config.ts";
import { createPiTodosProvider, detectPiTodos } from "./pi-todos.ts";
import type { TodoProvider, TodoProviderEnv } from "./types.ts";

export type { TodoProvider, TodoProviderEnv } from "./types.ts";
export { detectPiTodos, resolveTodoDir } from "./pi-todos.ts";

/**
 * Pick a todo provider for this session, or undefined to stay widget-only.
 *
 * Only pi-todos is implemented today. oh-my-pi's native todo panel is the
 * obvious second provider, but as of omp 17.1.5 the panel repaint is gated to
 * the built-in `todo` tool (`modes/controllers/event-controller.ts`, plus the
 * same guard in `session/agent-session.ts`), and the session handed to an
 * extension-registered tool is a read-only projection without the todo
 * accessors. A third-party extension therefore cannot repaint that panel; when
 * upstream opens it up, an omp provider drops in here behind the same
 * interface with no caller changes.
 */
export function resolveTodoProvider(
	config: PlannotatorConfig,
	env: TodoProviderEnv,
): TodoProvider | undefined {
	if (!resolveTodoProviderEnabled(config)) return undefined;
	if (!detectPiTodos(env.cwd)) return undefined;
	return createPiTodosProvider(env);
}
