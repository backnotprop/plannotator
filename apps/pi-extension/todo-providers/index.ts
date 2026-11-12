import { type PlannotatorConfig, resolveTodoProviderEnabled } from "../generated/config.ts";
import { createPiTodosProvider, detectPiTodos } from "./pi-todos.ts";
import type { TodoProvider, TodoProviderEnv } from "./types.ts";

export type { TodoProvider, TodoProviderEnv } from "./types.ts";
export { detectPiTodos, resolveTodoDir } from "./pi-todos.ts";

export function resolveTodoProvider(
	config: PlannotatorConfig,
	env: TodoProviderEnv,
): TodoProvider | undefined {
	if (!resolveTodoProviderEnabled(config)) return undefined;
	if (!detectPiTodos(env.cwd)) return undefined;
	return createPiTodosProvider(env);
}
