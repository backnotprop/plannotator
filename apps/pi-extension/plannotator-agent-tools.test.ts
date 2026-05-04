import { describe, expect, test } from "bun:test";
import { registerPlannotatorAgentTools } from "./plannotator-agent-tools";

type RegisteredTool = {
	name: string;
	description: string;
	execute: (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
};

function createPiMock(handler: (channel: string, request: any) => void) {
	const tools = new Map<string, RegisteredTool>();
	return {
		tools,
		pi: {
			registerTool(tool: RegisteredTool) {
				tools.set(tool.name, tool);
			},
			events: {
				emit: handler,
			},
		},
	};
}

describe("Plannotator agent tools", () => {
	test("registers annotate and annotate-last tools", () => {
		const mock = createPiMock(() => undefined);

		registerPlannotatorAgentTools(mock.pi as never);

		expect([...mock.tools.keys()].sort()).toEqual(["plannotator_annotate", "plannotator_annotate_last"]);
	});

	test("plannotator_annotate emits annotate request and returns feedback", async () => {
		const mock = createPiMock((_channel, request) => {
			expect(_channel).toBe("plannotator:request");
			expect(request.action).toBe("annotate");
			expect(request.payload).toEqual({ filePath: "/tmp/spec.md", gate: true });
			request.respond({ status: "handled", result: { feedback: "Clarify scope." } });
		});
		registerPlannotatorAgentTools(mock.pi as never);

		const result = await mock.tools.get("plannotator_annotate")!.execute("call-1", { filePath: "/tmp/spec.md", gate: true }, undefined, undefined, {});

		expect(result.content[0].text).toBe("Clarify scope.");
		expect(result.details).toEqual({ feedback: "Clarify scope." });
	});

	test("plannotator_annotate_last emits annotate-last request and reports approval", async () => {
		const mock = createPiMock((_channel, request) => {
			expect(_channel).toBe("plannotator:request");
			expect(request.action).toBe("annotate-last");
			expect(request.payload).toEqual({ filePath: "", gate: true });
			request.respond({ status: "handled", result: { feedback: "", approved: true } });
		});
		registerPlannotatorAgentTools(mock.pi as never);

		const result = await mock.tools.get("plannotator_annotate_last")!.execute("call-2", { gate: true }, undefined, undefined, {});

		expect(result.content[0].text).toBe("Approved.");
		expect(result.details).toEqual({ feedback: "", approved: true });
	});

	test("returns error text when Plannotator is unavailable", async () => {
		const mock = createPiMock((_channel, request) => {
			request.respond({ status: "unavailable", error: "No active session" });
		});
		registerPlannotatorAgentTools(mock.pi as never);

		const result = await mock.tools.get("plannotator_annotate")!.execute("call-3", { filePath: "/tmp/spec.md" }, undefined, undefined, {});

		expect(result.content[0].text).toBe("Plannotator unavailable: No active session");
	});
});
