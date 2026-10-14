/**
 * Unit tests for the turn lifecycle state machine.
 *
 * Verifies that all 11 states conform strictly to the transition table:
 * - Allowed transitions succeed and return the target state.
 * - Illegal transitions throw `StateTransitionError` with the formatted error message.
 * - Terminal states (`completed`, `failed`, `cancelled`) have no outgoing transitions.
 * - `isTerminal` correctly partitions the 11 states into 3 terminal and 8 non-terminal states.
 */

import { describe, expect, it } from "vitest";
import {
  isTerminal,
  StateTransitionError,
  TRANSITIONS,
  type TurnState,
  transition,
} from "./state-machine.ts";

const ALL_STATES: readonly TurnState[] = [
  "queued",
  "planning_scene",
  "needs_input",
  "planning_geometry",
  "building",
  "verifying",
  "applying",
  "stale",
  "completed",
  "failed",
  "cancelled",
];

const EXPECTED_TRANSITIONS: Record<TurnState, readonly TurnState[]> = {
  queued: ["planning_scene", "cancelled"],
  planning_scene: ["needs_input", "planning_geometry", "failed", "cancelled"],
  needs_input: ["planning_scene", "cancelled"],
  planning_geometry: ["building", "planning_geometry", "failed", "cancelled"],
  building: ["verifying", "planning_geometry", "failed", "cancelled"],
  verifying: ["applying", "planning_geometry", "failed", "cancelled"],
  applying: ["planning_geometry", "completed", "stale", "failed"],
  stale: ["planning_scene", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

describe("TRANSITIONS table", () => {
  it("contains all 11 states as keys", () => {
    expect(TRANSITIONS.size).toBe(11);
    for (const state of ALL_STATES) {
      expect(TRANSITIONS.has(state)).toBe(true);
    }
  });

  it("matches the exact transition specification for each state", () => {
    for (const state of ALL_STATES) {
      const allowed = TRANSITIONS.get(state);
      expect(allowed).toEqual(EXPECTED_TRANSITIONS[state]);
    }
  });
});

describe("transition()", () => {
  it("allows every defined transition in the transition table", () => {
    for (const from of ALL_STATES) {
      const targets = EXPECTED_TRANSITIONS[from];
      for (const to of targets) {
        expect(transition(from, to)).toBe(to);
      }
    }
  });

  it("throws StateTransitionError on disallowed transitions", () => {
    for (const from of ALL_STATES) {
      const targets = new Set(EXPECTED_TRANSITIONS[from]);
      for (const to of ALL_STATES) {
        if (!targets.has(to)) {
          expect(() => transition(from, to)).toThrowError(StateTransitionError);
          try {
            transition(from, to);
          } catch (err) {
            expect(err).toBeInstanceOf(StateTransitionError);
            const transitionErr = err as StateTransitionError;
            expect(transitionErr.name).toBe("StateTransitionError");
            expect(transitionErr.from).toBe(from);
            expect(transitionErr.to).toBe(to);
            expect(transitionErr.message).toBe(`Invalid turn state transition: ${from} → ${to}`);
          }
        }
      }
    }
  });

  it("prevents any transitions out of terminal states", () => {
    const terminalStates: TurnState[] = ["completed", "failed", "cancelled"];
    for (const term of terminalStates) {
      for (const next of ALL_STATES) {
        expect(() => transition(term, next)).toThrow(
          `Invalid turn state transition: ${term} → ${next}`,
        );
      }
    }
  });

  it("allows self-transition on planning_geometry (Gate 1 repair retry)", () => {
    expect(transition("planning_geometry", "planning_geometry")).toBe("planning_geometry");
  });

  it("disallows self-transitions on states that do not explicitly permit them", () => {
    const statesWithoutSelfTransition = ALL_STATES.filter((s) => s !== "planning_geometry");
    for (const state of statesWithoutSelfTransition) {
      expect(() => transition(state, state)).toThrowError(StateTransitionError);
    }
  });
});

describe("isTerminal()", () => {
  it("returns true only for completed, failed, and cancelled", () => {
    expect(isTerminal("completed")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
  });

  it("returns false for all 8 active/in-flight states", () => {
    const nonTerminalStates: TurnState[] = [
      "queued",
      "planning_scene",
      "needs_input",
      "planning_geometry",
      "building",
      "verifying",
      "applying",
      "stale",
    ];

    for (const state of nonTerminalStates) {
      expect(isTerminal(state)).toBe(false);
    }
  });
});

describe("StateTransitionError", () => {
  it("formats the error message with Unicode right arrow", () => {
    const error = new StateTransitionError("queued", "completed");
    expect(error.message).toBe("Invalid turn state transition: queued → completed");
    expect(error.from).toBe("queued");
    expect(error.to).toBe("completed");
    expect(error.name).toBe("StateTransitionError");
    expect(error).toBeInstanceOf(Error);
  });
});
