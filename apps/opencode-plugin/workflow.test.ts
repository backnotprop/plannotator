import { describe, expect, test } from "bun:test";
import {
  applyWorkflowConfig,
  normalizeWorkflowOptions,
  shouldApplyToolDefinitionRewrites,
  shouldInjectFullPlanningPrompt,
  shouldInjectGenericPlanReminder,
  shouldModifyPrompts,
  shouldRegisterSubmitPlan,
  shouldRejectSubmitPlanForAgent,
} from "./workflow";

describe("normalizeWorkflowOptions", () => {
  test("defaults omitted options to plan-agent with the plan agent", () => {
    const options = normalizeWorkflowOptions(undefined);

    expect(options.workflow).toBe("plan-agent");
    expect(options.planningAgents).toEqual(["plan"]);
    expect(options.planningAgentSet.has("plan")).toBe(true);
  });

  test("falls back to plan-agent for unknown workflows", () => {
    const options = normalizeWorkflowOptions({ workflow: "auto-everywhere" });

    expect(options.workflow).toBe("plan-agent");
  });

  test("always includes plan and adds trimmed unique planning agents", () => {
    const options = normalizeWorkflowOptions({
      workflow: "plan-agent",
      planningAgents: [" planner ", "", "planner", 123],
    });

    expect(options.planningAgents).toEqual(["plan", "planner"]);
  });

  test("keeps the built-in plan agent when the configured list is empty", () => {
    const options = normalizeWorkflowOptions({
      workflow: "plan-agent",
      planningAgents: ["", "   "],
    });

    expect(options.planningAgents).toEqual(["plan"]);
  });
});

describe("workflow gates", () => {
  test("manual mode is commands-only", () => {
    const options = normalizeWorkflowOptions({ workflow: "manual" });

    expect(shouldRegisterSubmitPlan(options)).toBe(false);
    expect(shouldApplyToolDefinitionRewrites(options)).toBe(false);
    expect(shouldInjectFullPlanningPrompt("plan", options)).toBe(false);
    expect(shouldRejectSubmitPlanForAgent("build", options)).toBe(false);
  });

  test("user-managed mode registers tool but skips prompt/config modifications", () => {
    const options = normalizeWorkflowOptions({ workflow: "user-managed" });

    expect(shouldRegisterSubmitPlan(options)).toBe(true);
    expect(shouldModifyPrompts(options)).toBe(false);
    expect(shouldApplyToolDefinitionRewrites(options)).toBe(false);
    expect(shouldInjectFullPlanningPrompt("plan", options)).toBe(false);
    expect(shouldRejectSubmitPlanForAgent("build", options)).toBe(false);
  });

  test("plan-agent mode injects only for configured planning agents", () => {
    const options = normalizeWorkflowOptions({
      workflow: "plan-agent",
      planningAgents: ["plan", "planner"],
    });

    expect(shouldRegisterSubmitPlan(options)).toBe(true);
    expect(shouldApplyToolDefinitionRewrites(options)).toBe(true);
    expect(shouldInjectFullPlanningPrompt("plan", options)).toBe(true);
    expect(shouldInjectFullPlanningPrompt("planner", options)).toBe(true);
    expect(shouldInjectFullPlanningPrompt("build", options)).toBe(false);
    expect(shouldInjectGenericPlanReminder("build", false, options)).toBe(false);
  });

  test("all-agents mode keeps the generic primary-agent reminder", () => {
    const options = normalizeWorkflowOptions({ workflow: "all-agents" });

    expect(shouldInjectGenericPlanReminder("reviewer", false, options)).toBe(true);
    expect(shouldInjectGenericPlanReminder("build", false, options)).toBe(false);
    expect(shouldInjectGenericPlanReminder("reviewer", true, options)).toBe(false);
    expect(shouldInjectGenericPlanReminder("plan", false, options)).toBe(false);
  });

  test("runtime guard rejects only non-planning agents in plan-agent mode", () => {
    const planAgent = normalizeWorkflowOptions({ workflow: "plan-agent" });
    const allAgents = normalizeWorkflowOptions({ workflow: "all-agents" });

    expect(shouldRejectSubmitPlanForAgent("plan", planAgent)).toBe(false);
    expect(shouldRejectSubmitPlanForAgent("build", planAgent)).toBe(true);
    expect(shouldRejectSubmitPlanForAgent(undefined, planAgent)).toBe(true);
    expect(shouldRejectSubmitPlanForAgent("build", allAgents)).toBe(false);
  });
});

describe("applyWorkflowConfig", () => {
  test("manual mode leaves OpenCode config untouched", () => {
    const config: any = {};

    applyWorkflowConfig(config, normalizeWorkflowOptions({ workflow: "manual" }), false);

    expect(config).toEqual({});
  });

  test("user-managed mode leaves OpenCode config untouched", () => {
    const config: any = {};

    applyWorkflowConfig(config, normalizeWorkflowOptions({ workflow: "user-managed" }), false);

    expect(config).toEqual({});
  });

  test("plan-agent mode exposes submit_plan to plan and denies build", () => {
    const config: any = {
      experimental: {
        primary_tools: ["bash"],
        other: true,
      },
    };

    applyWorkflowConfig(config, normalizeWorkflowOptions(undefined), false);

    expect(config.experimental).toEqual({
      primary_tools: ["bash", "submit_plan"],
      other: true,
    });
    expect(config.agent.plan.permission.submit_plan).toBe("allow");
    expect(config.agent.plan.permission.edit).toEqual({ "*.md": "allow" });
    expect(config.agent.build.permission.submit_plan).toBe("deny");
  });

  test("plan-agent mode preserves user agent fields and adds custom planning agents", () => {
    const config: any = {
      agent: {
        planner: {
          mode: "primary",
          model: "test-model",
          prompt: "custom prompt",
          permission: {
            bash: "deny",
            edit: "deny",
          },
        },
      },
    };

    applyWorkflowConfig(
      config,
      normalizeWorkflowOptions({
        workflow: "plan-agent",
        planningAgents: ["planner"],
      }),
      false,
    );

    expect(config.agent.planner.model).toBe("test-model");
    expect(config.agent.planner.prompt).toBe("custom prompt");
    expect(config.agent.planner.permission.bash).toBe("deny");
    expect(config.agent.planner.permission.submit_plan).toBe("allow");
    expect(config.agent.planner.permission.edit).toEqual({
      "*": "deny",
      "*.md": "allow",
    });
    expect(config.agent.plan.permission.submit_plan).toBe("allow");
  });

  test("plan-agent mode treats planningAgents as additive to built-in plan", () => {
    const config: any = {};

    applyWorkflowConfig(
      config,
      normalizeWorkflowOptions({
        workflow: "plan-agent",
        planningAgents: ["planner"],
      }),
      false,
    );

    expect(config.agent.plan.permission.submit_plan).toBe("allow");
    expect(config.agent.planner.permission.submit_plan).toBe("allow");
    expect(config.agent.build.permission.submit_plan).toBe("deny");
  });

  test("plan-agent mode denies user-configured non-planning primary agents", () => {
    const config: any = {
      agent: {
        reviewer: {
          mode: "primary",
          permission: {
            bash: "ask",
          },
        },
        helper: {
          mode: "subagent",
          permission: {
            bash: "ask",
          },
        },
      },
    };

    applyWorkflowConfig(config, normalizeWorkflowOptions(undefined), false);

    expect(config.agent.reviewer.permission.submit_plan).toBe("deny");
    expect(config.agent.helper.permission.submit_plan).toBeUndefined();
  });

  test("allow-subagents mode also denies non-planning subagents", () => {
    const config: any = {
      agent: {
        helper: {
          mode: "subagent",
          permission: {},
        },
      },
    };

    applyWorkflowConfig(config, normalizeWorkflowOptions(undefined), true);

    expect(config.experimental?.primary_tools).toBeUndefined();
    expect(config.agent.helper.permission.submit_plan).toBe("deny");
  });

  test("all-agents mode preserves broad access while allowing planning agents", () => {
    const config: any = {
      agent: {
        build: {
          permission: {
            bash: "ask",
          },
        },
      },
    };

    applyWorkflowConfig(config, normalizeWorkflowOptions({ workflow: "all-agents" }), false);

    expect(config.agent.plan.permission.submit_plan).toBe("allow");
    expect(config.agent.build.permission.submit_plan).toBeUndefined();
    expect(config.agent.build.permission.bash).toBe("ask");
    expect(config.experimental.primary_tools).toEqual(["submit_plan"]);
  });
});
