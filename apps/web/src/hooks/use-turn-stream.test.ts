import { describe, expect, it, vi } from "vitest";
import {
  INITIAL_TURN_STREAM_STATE,
  processTurnEvent,
  type TurnStreamEvent,
} from "./use-turn-stream.ts";

describe("processTurnEvent", () => {
  it("processes turn.state_changed and tracks timeline", () => {
    let state = INITIAL_TURN_STREAM_STATE;

    const event: TurnStreamEvent = {
      type: "turn.state_changed",
      turnId: "turn-1",
      from: "queued",
      to: "planning_scene",
      timestamp: "2026-10-14T12:00:00Z",
    };

    state = processTurnEvent(state, event);
    expect(state.turnId).toBe("turn-1");
    expect(state.currentState).toBe("planning_scene");
    expect(state.previousState).toBe("queued");
    expect(state.timeline).toHaveLength(1);
    expect(state.timeline[0]).toEqual({
      from: "queued",
      to: "planning_scene",
      timestamp: "2026-10-14T12:00:00Z",
    });
  });

  it("processes turn.needs_input and populates clarificationState", () => {
    let state = INITIAL_TURN_STREAM_STATE;

    const event: TurnStreamEvent = {
      type: "turn.needs_input",
      turnId: "turn-1",
      ambiguityReason: "Missing tabletop dimensions",
      questions: ["What is the desired width?", "What wood finish?"],
    };

    state = processTurnEvent(state, event);
    expect(state.currentState).toBe("needs_input");
    expect(state.clarificationState).toEqual({
      turnId: "turn-1",
      ambiguityReason: "Missing tabletop dimensions",
      questions: ["What is the desired width?", "What wood finish?"],
    });

    // When transitioning away from needs_input, clarificationState is cleared
    const stateChange: TurnStreamEvent = {
      type: "turn.state_changed",
      turnId: "turn-1",
      from: "needs_input",
      to: "planning_scene",
      timestamp: "2026-10-14T12:01:00Z",
    };
    state = processTurnEvent(state, stateChange);
    expect(state.clarificationState).toBeNull();
  });

  it("processes turn.plan_ready and initializes steps with 3 pending gates", () => {
    let state = INITIAL_TURN_STREAM_STATE;

    const event: TurnStreamEvent = {
      type: "turn.plan_ready",
      turnId: "turn-1",
      sceneSummary: "Executive office desk with drawers",
      totalSteps: 2,
      steps: [
        { stepId: "step_0", goal: "Build desk frame and top" },
        { stepId: "step_1", goal: "Add storage drawers" },
      ],
    };

    state = processTurnEvent(state, event);
    expect(state.plan).not.toBeNull();
    expect(state.plan?.totalSteps).toBe(2);
    expect(state.plan?.steps).toHaveLength(2);
    expect(state.plan?.steps[0]).toEqual({
      stepIndex: 0,
      stepId: "step_0",
      goal: "Build desk frame and top",
      status: "pending",
      attempt: 0,
      activeModel: null,
      gates: { 1: null, 2: null, 3: null },
      history: [],
    });
  });

  it("processes turn.step_started and archives prior attempt history", () => {
    let state = processTurnEvent(INITIAL_TURN_STREAM_STATE, {
      type: "turn.plan_ready",
      turnId: "turn-1",
      sceneSummary: "Desk",
      totalSteps: 1,
      steps: [{ stepId: "step_0", goal: "Frame" }],
    });

    // First attempt starts
    state = processTurnEvent(state, {
      type: "turn.step_started",
      turnId: "turn-1",
      stepIndex: 0,
      stepId: "step_0",
      attempt: 1,
      model: "qwen/qwen-2.5-coder-32b-instruct",
    });

    expect(state.plan?.steps[0]?.status).toBe("active");
    expect(state.plan?.steps[0]?.attempt).toBe(1);
    expect(state.plan?.steps[0]?.activeModel).toBe(
      "qwen/qwen-2.5-coder-32b-instruct",
    );

    // Gate 1 fails on attempt 1
    state = processTurnEvent(state, {
      type: "turn.gate_result",
      turnId: "turn-1",
      stepId: "step_0",
      attempt: 1,
      gate: 1,
      passed: false,
      diagnostics: "Unexpected comma at line 14",
    });

    expect(state.plan?.steps[0]?.gates[1]?.passed).toBe(false);
    expect(state.plan?.steps[0]?.gates[1]?.diagnostics).toBe(
      "Unexpected comma at line 14",
    );

    // Second attempt starts
    state = processTurnEvent(state, {
      type: "turn.step_started",
      turnId: "turn-1",
      stepIndex: 0,
      stepId: "step_0",
      attempt: 2,
      model: "qwen/qwen-2.5-coder-32b-instruct",
    });

    expect(state.plan?.steps[0]?.attempt).toBe(2);
    // Gates for attempt 2 reset to pending
    expect(state.plan?.steps[0]?.gates[1]).toBeNull();
    // History contains attempt 1 with its failure diagnostics
    expect(state.plan?.steps[0]?.history).toHaveLength(1);
    expect(state.plan?.steps[0]?.history[0]?.attempt).toBe(1);
    expect(state.plan?.steps[0]?.history[0]?.gates[1]?.passed).toBe(false);
    expect(state.plan?.steps[0]?.history[0]?.gates[1]?.diagnostics).toBe(
      "Unexpected comma at line 14",
    );
  });

  it("processes turn.gate_result across all 3 gates", () => {
    let state = processTurnEvent(INITIAL_TURN_STREAM_STATE, {
      type: "turn.plan_ready",
      turnId: "turn-1",
      sceneSummary: "Desk",
      totalSteps: 1,
      steps: [{ stepId: "step_0", goal: "Frame" }],
    });

    state = processTurnEvent(state, {
      type: "turn.step_started",
      turnId: "turn-1",
      stepIndex: 0,
      stepId: "step_0",
      attempt: 1,
      model: "qwen/qwen-2.5-coder-32b-instruct",
    });

    // Gate 1: JSON passes
    state = processTurnEvent(state, {
      type: "turn.gate_result",
      turnId: "turn-1",
      stepId: "step_0",
      attempt: 1,
      gate: 1,
      passed: true,
    });
    expect(state.plan?.steps[0]?.gates[1]?.passed).toBe(true);

    // Gate 2: Schema passes
    state = processTurnEvent(state, {
      type: "turn.gate_result",
      turnId: "turn-1",
      stepId: "step_0",
      attempt: 1,
      gate: 2,
      passed: true,
    });
    expect(state.plan?.steps[0]?.gates[2]?.passed).toBe(true);

    // Gate 3: Vision passes
    state = processTurnEvent(state, {
      type: "turn.gate_result",
      turnId: "turn-1",
      stepId: "step_0",
      attempt: 1,
      gate: 3,
      passed: true,
    });
    expect(state.plan?.steps[0]?.gates[3]?.passed).toBe(true);
  });

  it("processes turn.step_committed, stale_rebase, and turn.completed", () => {
    let state = processTurnEvent(INITIAL_TURN_STREAM_STATE, {
      type: "turn.plan_ready",
      turnId: "turn-1",
      sceneSummary: "Desk",
      totalSteps: 1,
      steps: [{ stepId: "step_0", goal: "Frame" }],
    });

    // Step committed
    state = processTurnEvent(state, {
      type: "turn.step_committed",
      turnId: "turn-1",
      stepIndex: 0,
      stepId: "step_0",
      newRevision: 2,
      sceneDelta: { op: "create_node", nodeId: "desk_frame" },
    });
    expect(state.plan?.steps[0]?.status).toBe("committed");

    // Stale rebase notification
    state = processTurnEvent(state, {
      type: "turn.stale_rebase",
      turnId: "turn-1",
      expectedRevision: 2,
      actualRevision: 3,
      rebaseAttempt: 1,
    });
    expect(state.currentState).toBe("stale");
    expect(state.rebaseAlert).toEqual({
      turnId: "turn-1",
      expectedRevision: 2,
      actualRevision: 3,
      rebaseAttempt: 1,
    });

    // Turn completed
    state = processTurnEvent(state, {
      type: "turn.completed",
      turnId: "turn-1",
      finalRevision: 4,
    });
    expect(state.currentState).toBe("completed");
    expect(state.isCompleted).toBe(true);
    expect(state.finalRevision).toBe(4);
    expect(state.rebaseAlert).toBeNull();
  });

  it("processes turn.failed and records failed step", () => {
    let state = processTurnEvent(INITIAL_TURN_STREAM_STATE, {
      type: "turn.plan_ready",
      turnId: "turn-1",
      sceneSummary: "Desk",
      totalSteps: 1,
      steps: [{ stepId: "step_0", goal: "Frame" }],
    });

    state = processTurnEvent(state, {
      type: "turn.failed",
      turnId: "turn-1",
      stepId: "step_0",
      reason: "Retry budget exhausted after 3 attempts",
    });

    expect(state.currentState).toBe("failed");
    expect(state.error).toEqual({
      reason: "Retry budget exhausted after 3 attempts",
      stepId: "step_0",
    });
    expect(state.plan?.steps[0]?.status).toBe("failed");
  });
});
