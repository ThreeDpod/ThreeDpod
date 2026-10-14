import { describe, expect, it } from "vitest";
import type { Env } from "../env.ts";
import type { TurnStreamEvent } from "../ws/event-stream.ts";
import { SceneRegistry, TurnRegistry } from "./registry.ts";
import { executeTurnStateMachine, type TurnRunnerDeps, type TurnRunnerInput } from "./turn-runner.ts";

const MOCK_ENV = {
  OPENROUTER_API_KEY: "test-key",
  OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
  ORCHESTRATOR_VISION_MODEL: "openai/gpt-5.6-luna",
  SCENE_PLANNER_MODEL: "deepseek/deepseek-r1",
  GEOMETRY_BUILDER_MODEL: "qwen/qwen-2.5-coder-32b-instruct",
  FALLBACK_BUILDER_MODEL: "openai/gpt-5.6-luna",
  TURN_MAX_RETRY_BUDGET: 3,
  TURN_MAX_REBASE_ATTEMPTS: 2,
} as unknown as Env;

const VALID_READY_PLAN = JSON.stringify({
  status: "ready",
  sceneSummary: "Desk with 4 legs",
  atomicSteps: [
    {
      stepIndex: 0,
      stepId: "tabletop_and_legs",
      goal: "Construct tabletop and 4 legs",
      targetNodes: ["tabletop", "leg_1"],
      spatialConstraints: [],
    },
  ],
});

const VALID_GEOM_STEP = JSON.stringify({
  stepId: "tabletop_and_legs",
  intentSummary: "Create tabletop and legs",
  operations: [
    {
      op: "create_node",
      nodeId: "tabletop",
      label: "Tabletop",
      nodeType: "mesh",
      parentId: null,
      geometry: { kind: "box", width: 1.2, height: 0.05, depth: 0.6 },
      material: { color: "#8b5a2b" },
      transform: { position: [0, 0.725, 0] },
    },
  ],
  assertions: [],
});

const VALID_VISION_ASSESSMENT = JSON.stringify({
  accepted: true,
  score: 95,
  observedIssues: [],
  targetedRevisionRequest: null,
});

async function pollUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
}

describe("executeTurnStateMachine", () => {
  it("executes full happy path through all gates and commits to SceneRegistry", async () => {
    const registry = new TurnRegistry();
    const sceneRegistry = new SceneRegistry();
    const emittedEvents: TurnStreamEvent[] = [];

    const deps: TurnRunnerDeps = {
      env: MOCK_ENV,
      registry,
      sceneRegistry,
      broadcastEvent: (_sessionId, event) => emittedEvents.push(event),
      callLlm: async ({ systemPrompt }) => {
        if (systemPrompt.includes("Procedural Geometry")) return VALID_GEOM_STEP;
        if (systemPrompt.includes("3D Scene Planner")) return VALID_READY_PLAN;
        if (systemPrompt.includes("Vision Validator")) return VALID_VISION_ASSESSMENT;
        return "{}";
      },
    };

    const input: TurnRunnerInput = {
      turnId: "turn-1",
      sessionId: "session-1",
      projectId: "proj-1",
      userId: "user-1",
      userMessage: "Build a desk",
      signal: new AbortController().signal,
    };

    const result = await executeTurnStateMachine(input, deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.finalRevision).toBe(1);
    }

    // Verify SceneRegistry committed
    expect(sceneRegistry.getRevision("proj-1")).toBe(1);
    const scene = sceneRegistry.getScene("proj-1");
    expect(scene.nodes.has("tabletop")).toBe(true);

    // Verify emitted state changes
    const states = emittedEvents
      .filter((e): e is Extract<TurnStreamEvent, { type: "turn.state_changed" }> => e.type === "turn.state_changed")
      .map((e) => e.to);
    expect(states).toEqual([
      "planning_scene",
      "planning_geometry",
      "building",
      "verifying",
      "applying",
      "completed",
    ]);

    // Verify all 3 gates reported passed
    const gateResults = emittedEvents.filter(
      (e): e is Extract<TurnStreamEvent, { type: "turn.gate_result" }> => e.type === "turn.gate_result",
    );
    expect(gateResults).toHaveLength(3);
    expect(gateResults[0]).toMatchObject({ gate: 1, passed: true });
    expect(gateResults[1]).toMatchObject({ gate: 2, passed: true });
    expect(gateResults[2]).toMatchObject({ gate: 3, passed: true });

    // Verify active turn unregistered at completion
    expect(registry.getTurn("turn-1")).toBeUndefined();
  });

  it("handles needs_input clarification and resumes to completion", async () => {
    const registry = new TurnRegistry();
    const sceneRegistry = new SceneRegistry();
    const emittedEvents: TurnStreamEvent[] = [];
    let planCalls = 0;

    const deps: TurnRunnerDeps = {
      env: MOCK_ENV,
      registry,
      sceneRegistry,
      broadcastEvent: (_sessionId, event) => emittedEvents.push(event),
      callLlm: async ({ systemPrompt }) => {
        if (systemPrompt.includes("3D Scene Planner")) {
          planCalls++;
          if (planCalls === 1) {
            return JSON.stringify({
              status: "needs_input",
              ambiguityReason: "Dimensions missing",
              questionsForUser: ["What dimensions?"],
            });
          }
          return VALID_READY_PLAN;
        }
        if (systemPrompt.includes("Procedural Geometry")) return VALID_GEOM_STEP;
        return VALID_VISION_ASSESSMENT;
      },
    };

    const input: TurnRunnerInput = {
      turnId: "turn-clarify",
      sessionId: "session-1",
      projectId: "proj-1",
      userId: "user-1",
      userMessage: "Build desk",
      signal: new AbortController().signal,
    };

    // Run in background and clarify via registry
    const runPromise = executeTurnStateMachine(input, deps);

    // Wait until registered in needs_input
    await pollUntil(() => registry.getTurn("turn-clarify")?.state === "needs_input");

    // Submit clarification
    const active = registry.getTurn("turn-clarify");
    expect(active?.submitClarification).toBeDefined();
    active?.submitClarification?.(["1.2m x 0.6m"]);

    const result = await runPromise;
    expect(result.ok).toBe(true);

    const states = emittedEvents
      .filter((e): e is Extract<TurnStreamEvent, { type: "turn.state_changed" }> => e.type === "turn.state_changed")
      .map((e) => e.to);

    expect(states).toContain("needs_input");
    expect(states).toContain("planning_scene");
    expect(states[states.length - 1]).toBe("completed");
  });

  it("retries on Gate 1 failure and recovers", async () => {
    const registry = new TurnRegistry();
    const sceneRegistry = new SceneRegistry();
    const emittedEvents: TurnStreamEvent[] = [];
    let geomCalls = 0;

    const deps: TurnRunnerDeps = {
      env: MOCK_ENV,
      registry,
      sceneRegistry,
      broadcastEvent: (_sessionId, event) => emittedEvents.push(event),
      callLlm: async ({ systemPrompt }) => {
        if (systemPrompt.includes("Procedural Geometry")) {
          geomCalls++;
          if (geomCalls === 1) return "invalid json output";
          return VALID_GEOM_STEP;
        }
        if (systemPrompt.includes("3D Scene Planner")) return VALID_READY_PLAN;
        return VALID_VISION_ASSESSMENT;
      },
    };

    const input: TurnRunnerInput = {
      turnId: "turn-retry-1",
      sessionId: "session-1",
      projectId: "proj-1",
      userId: "user-1",
      userMessage: "Build a desk",
      signal: new AbortController().signal,
    };

    const result = await executeTurnStateMachine(input, deps);
    expect(result.ok).toBe(true);

    const gate1Results = emittedEvents.filter(
      (e): e is Extract<TurnStreamEvent, { type: "turn.gate_result" }> =>
        e.type === "turn.gate_result" && e.gate === 1,
    );
    expect(gate1Results).toHaveLength(2);
    expect(gate1Results[0]?.passed).toBe(false);
    expect(gate1Results[1]?.passed).toBe(true);
  });

  it("switches to fallback builder model on final retry attempt", async () => {
    const registry = new TurnRegistry();
    const sceneRegistry = new SceneRegistry();
    const emittedEvents: TurnStreamEvent[] = [];
    const modelsUsed: string[] = [];

    const deps: TurnRunnerDeps = {
      env: MOCK_ENV,
      registry,
      sceneRegistry,
      broadcastEvent: (_sessionId, event) => emittedEvents.push(event),
      callLlm: async ({ config, systemPrompt }) => {
        if (systemPrompt.includes("3D Scene Planner")) return VALID_READY_PLAN;
        if (systemPrompt.includes("Procedural Geometry")) {
          modelsUsed.push(config.model);
          // Fail twice, succeed on 3rd attempt (fallback model)
          if (config.model === MOCK_ENV.FALLBACK_BUILDER_MODEL) {
            return VALID_GEOM_STEP;
          }
          return "bad json";
        }
        return VALID_VISION_ASSESSMENT;
      },
    };

    const input: TurnRunnerInput = {
      turnId: "turn-fallback",
      sessionId: "session-1",
      projectId: "proj-1",
      userId: "user-1",
      userMessage: "Build a desk",
      signal: new AbortController().signal,
    };

    const result = await executeTurnStateMachine(input, deps);
    expect(result.ok).toBe(true);

    // Attempts 1 and 2 used Qwen, attempt 3 used fallback GPT Luna
    expect(modelsUsed).toEqual([
      MOCK_ENV.GEOMETRY_BUILDER_MODEL,
      MOCK_ENV.GEOMETRY_BUILDER_MODEL,
      MOCK_ENV.FALLBACK_BUILDER_MODEL,
    ]);
  });

  it("rebases when base revision is stale and completes", async () => {
    const registry = new TurnRegistry();
    const sceneRegistry = new SceneRegistry();
    const emittedEvents: TurnStreamEvent[] = [];
    let buildStepCalls = 0;

    const deps: TurnRunnerDeps = {
      env: MOCK_ENV,
      registry,
      sceneRegistry,
      broadcastEvent: (_sessionId, event) => emittedEvents.push(event),
      callLlm: async ({ systemPrompt }) => {
        if (systemPrompt.includes("Procedural Geometry")) {
          buildStepCalls++;
          // Simulate concurrent modification before first commit
          if (buildStepCalls === 1) {
            const current = sceneRegistry.getScene("proj-conflict");
            sceneRegistry.commitCandidate("proj-conflict", current.revision, current);
          }
          return VALID_GEOM_STEP;
        }
        if (systemPrompt.includes("3D Scene Planner")) return VALID_READY_PLAN;
        return VALID_VISION_ASSESSMENT;
      },
    };

    const input: TurnRunnerInput = {
      turnId: "turn-stale",
      sessionId: "session-1",
      projectId: "proj-conflict",
      userId: "user-1",
      userMessage: "Build a desk",
      signal: new AbortController().signal,
    };

    const result = await executeTurnStateMachine(input, deps);
    expect(result.ok).toBe(true);

    const rebaseEvents = emittedEvents.filter((e) => e.type === "turn.stale_rebase");
    expect(rebaseEvents).toHaveLength(1);

    const states = emittedEvents
      .filter((e): e is Extract<TurnStreamEvent, { type: "turn.state_changed" }> => e.type === "turn.state_changed")
      .map((e) => e.to);
    expect(states).toContain("stale");
    expect(states).toContain("completed");
  });

  it("handles cancellation gracefully", async () => {
    const registry = new TurnRegistry();
    const sceneRegistry = new SceneRegistry();
    const controller = new AbortController();
    const emittedEvents: TurnStreamEvent[] = [];

    const deps: TurnRunnerDeps = {
      env: MOCK_ENV,
      registry,
      sceneRegistry,
      broadcastEvent: (_sessionId, event) => emittedEvents.push(event),
      callLlm: async () => {
        controller.abort();
        return VALID_READY_PLAN;
      },
    };

    const input: TurnRunnerInput = {
      turnId: "turn-cancel",
      sessionId: "session-1",
      projectId: "proj-1",
      userId: "user-1",
      userMessage: "Build a desk",
      signal: controller.signal,
    };

    const result = await executeTurnStateMachine(input, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.state).toBe("cancelled");
    }
    expect(registry.getTurn("turn-cancel")).toBeUndefined();
  });
});
