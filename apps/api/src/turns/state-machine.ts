/**
 * Turn lifecycle state machine with strictly enforced transitions.
 *
 * ## Architecture & Motivation
 *
 * In ThreePod's multi-model pipeline, a user's conversational scene edit is not a
 * monolithic LLM call. Instead, it is an asynchronous, multi-phase pipeline involving:
 *
 *   1. **Intake & Scene Planning** (`planning_scene`): Multimodal parsing (GPT Luna)
 *      followed by structural decomposition (DeepSeek-R1) into ordered atomic steps.
 *   2. **Human-in-the-Loop Clarification** (`needs_input`): When the scene planner
 *      detects underspecified or ambiguous requirements that cannot be safely defaulted,
 *      execution suspends until user input is received.
 *   3. **Procedural Geometry Generation** (`planning_geometry`): The geometry builder
 *      (Qwen 2.5 Coder or fallback) synthesizes procedural JSON for each step.
 *   4. **Deterministic Validation & Construction** (`building`): Gate 1 (JSON parse)
 *      and Gate 2 (schema, referential integrity, spatial constraints, AABB resolution)
 *      validate and build a candidate scene graph.
 *   5. **Vision Verification** (`verifying`): Gate 3 (GPT Luna) inspects rendered
 *      screenshots of the candidate to detect visual regressions.
 *   6. **Atomic Application** (`applying`): The candidate is committed to the
 *      SceneRegistry under optimistic concurrency control.
 *   7. **Rebasing on Conflict** (`stale`): If a concurrent turn committed a new revision
 *      while this turn was planning or building, optimistic concurrency fails and the turn
 *      rebases from `stale` back to `planning_scene`.
 *   8. **Terminal States** (`completed`, `failed`, `cancelled`): Sinks where turn execution halts.
 *
 * ## Why an explicit state machine?
 *
 * Without an explicit, strictly guarded state machine, race conditions and orchestration bugs
 * can easily corrupt the scene or waste model tokens:
 * - A turn could jump straight from `queued` to `building` without a scene plan.
 * - A cancelled or failed turn could continue executing subsequent steps in the background.
 * - Gate failure retry loops could recurse infinitely without adhering to the retry budget.
 * - Concurrent turns could overwrite each other without respecting the optimistic concurrency
 *   invalidation cycle (`applying` → `stale` → `planning_scene`).
 *
 * The transition table defined here acts as the single source of truth for permissible lifecycle
 * progressions. All transitions are pure and throw `StateTransitionError` upon any invalid attempt.
 */

import type { ScenePlanReady } from "./schemas.ts";

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * The 11 discrete states of a turn lifecycle.
 *
 * States represent distinct stages of planning, execution, verification, user interaction,
 * conflict resolution, or termination.
 */
export type TurnState =
  /** Initial state when a turn is created in the queue. */
  | "queued"
  /** Orchestrator parses intent (multimodal) and Scene Planner evaluates & decomposes. */
  | "planning_scene"
  /** Ambiguity blocks safe planning; turn pauses for user clarification. */
  | "needs_input"
  /** Geometry Planner generates procedural JSON for the current atomic step. */
  | "planning_geometry"
  /** Deterministic Builder validates schema, constraints, and constructs candidate. */
  | "building"
  /** Vision Validator inspects rendered candidate screenshots for quality/regressions. */
  | "verifying"
  /** Candidate passed all gates and is being proposed/committed to SceneRegistry. */
  | "applying"
  /** Conflict detected: scene base revision changed during turn execution. */
  | "stale"
  /** Terminal state: all atomic steps succeeded and committed. */
  | "completed"
  /** Terminal state: fatal unrecoverable error or retry/rebase budget exhausted. */
  | "failed"
  /** Terminal state: user or system aborted execution. */
  | "cancelled";

/**
 * Thrown when an illegal state transition is attempted.
 *
 * Captures both `from` and `to` states so callers, turn loggers, and telemetry
 * can pinpoint the invalid sequence.
 */
export class StateTransitionError extends Error {
  readonly from: TurnState;
  readonly to: TurnState;

  constructor(from: TurnState, to: TurnState) {
    super(`Invalid turn state transition: ${from} → ${to}`);
    this.name = "StateTransitionError";
    this.from = from;
    this.to = to;
  }
}

// ── Transition Table ─────────────────────────────────────────────────────────

/**
 * Complete transition graph for the 11 turn states.
 *
 * Allowed transitions:
 *
 * 1. `queued`            → `planning_scene` | `cancelled`
 * 2. `planning_scene`    → `needs_input` | `planning_geometry` | `failed` | `cancelled`
 * 3. `needs_input`       → `planning_scene` | `cancelled`
 * 4. `planning_geometry` → `building` | `planning_geometry` (Gate 1 retry) | `failed` | `cancelled`
 * 5. `building`          → `verifying` | `planning_geometry` (Gate 2 retry) | `failed` | `cancelled`
 * 6. `verifying`         → `applying` | `planning_geometry` (Gate 3 retry) | `failed` | `cancelled`
 * 7. `applying`          → `planning_geometry` (next step) | `completed` | `stale` | `failed`
 * 8. `stale`             → `planning_scene` (rebase) | `failed`
 *
 * Terminal states (`completed`, `failed`, `cancelled`) have no outgoing transitions.
 */
export const TRANSITIONS: ReadonlyMap<TurnState, readonly TurnState[]> = new Map<
  TurnState,
  readonly TurnState[]
>([
  ["queued", ["planning_scene", "cancelled"]],
  ["planning_scene", ["needs_input", "planning_geometry", "failed", "cancelled"]],
  ["needs_input", ["planning_scene", "cancelled"]],
  ["planning_geometry", ["building", "planning_geometry", "failed", "cancelled"]],
  ["building", ["verifying", "planning_geometry", "failed", "cancelled"]],
  ["verifying", ["applying", "planning_geometry", "failed", "cancelled"]],
  ["applying", ["planning_geometry", "completed", "stale", "failed"]],
  ["stale", ["planning_scene", "failed"]],
  ["completed", []],
  ["failed", []],
  ["cancelled", []],
]);

// ── Pure Transition Functions ────────────────────────────────────────────────

/**
 * Validates and executes a transition from one turn state to another.
 *
 * Pure function: looks up `from` in {@link TRANSITIONS}, verifies that `to` is an
 * allowed destination, and returns `to`. Throws {@link StateTransitionError} if the
 * transition is disallowed.
 *
 * @param from The current state of the turn.
 * @param to The target state to transition into.
 * @returns The target state if the transition is allowed.
 * @throws {StateTransitionError} If the transition is not permitted by {@link TRANSITIONS}.
 */
export function transition(from: TurnState, to: TurnState): TurnState {
  const allowed = TRANSITIONS.get(from);
  if (!allowed?.includes(to)) {
    throw new StateTransitionError(from, to);
  }
  return to;
}

/**
 * Determines whether a turn state is terminal.
 *
 * Terminal states represent the end of the turn's lifecycle. Once a turn enters
 * a terminal state (`completed`, `failed`, or `cancelled`), no further transitions
 * are permitted and any leased workers or resources may be safely released.
 *
 * @param state The state to check.
 * @returns `true` if the state is terminal; otherwise `false`.
 */
export function isTerminal(state: TurnState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

// ── Turn Context ─────────────────────────────────────────────────────────────

/**
 * Runtime state and configuration of a turn tracked throughout the pipeline.
 *
 * Carries the operational metadata needed to make retry decisions, bound rebase
 * loops under concurrency contention, pass gate diagnostics into repair prompts,
 * and enforce cooperative cancellation via `signal`.
 */
export type TurnContext = {
  /** Unique identifier for this turn request. */
  turnId: string;
  /** Project this turn belongs to. */
  projectId: string;
  /** Session within which this turn is executing. */
  sessionId: string;
  /** Current state of the turn in the state machine. */
  state: TurnState;
  /** The base revision of the scene when this turn started planning. */
  baseRevision: number;
  /** Total retry attempts spent across all gates for the current atomic step. */
  retriesUsed: number;
  /** Max retries per atomic step (from TURN_MAX_RETRY_BUDGET env). */
  retryBudget: number;
  /** How many times the turn has rebased due to stale conflicts. */
  rebaseAttempts: number;
  /** Max rebase attempts (from TURN_MAX_REBASE_ATTEMPTS env). */
  maxRebaseAttempts: number;
  /** Index into the atomicSteps array from the scene plan. */
  currentStepIndex: number;
  /** The full scene plan, populated after planning_scene succeeds. */
  scenePlan: ScenePlanReady | null;
  /** Diagnostics from the last failed gate, passed to geometry planner on retry. */
  lastRepairDiagnostics: string | null;
  /** The abort signal for cancellation. */
  signal: AbortSignal;
};
