/**
 * Geometry planner: the `planning_geometry` stage of the turn pipeline.
 *
 * Invokes the Geometry Builder model (Qwen 2.5 by default, or GPT Luna as fallback)
 * to generate procedural JSON for a single atomic step. The result is validated
 * against `ProceduralStepSchema` at Gate 1 (JSON parse + schema validation).
 *
 * If a previous attempt failed at any gate, the `repairDiagnostics` string is
 * included in the prompt so the model can address the specific issues.
 *
 * Like the scene planner, this is a pure function of its inputs — the model caller
 * is injected, making it testable without a running API account.
 */

import type { ModelConfig } from "./model-access.ts";
import { extractCleanJson } from "./model-access.ts";
import {
  ProceduralStepSchema,
  type ProceduralStep,
  type ScenePlanAtomicStep,
} from "./schemas.ts";
import { GEOMETRY_BUILDER_PROMPT } from "./prompts.ts";
import type { LlmCaller } from "./scene-planner.ts";

// ── Types ────────────────────────────────────────────────────────────────────

/** The scene state summary passed to the geometry builder. */
export type CommittedSceneState = {
  /** Node IDs, hierarchy, bounding boxes, geometries, materials — as JSON. */
  nodes: unknown[];
  /** The revision number this state represents. */
  revision: number;
};

/** What the caller hands in for a geometry planning request. */
export type GeometryPlannerInput = {
  /** The committed scene state the builder reads from. */
  committedSceneState: CommittedSceneState;
  /** The single atomic step from the scene plan to build. */
  currentAtomicStep: ScenePlanAtomicStep;
  /**
   * Diagnostics from a previous failed attempt:
   * - Gate 1: JSON parse error message
   * - Gate 2: Schema/operation/AABB constraint diagnostics
   * - Gate 3: Vision validator's `targetedRevisionRequest`
   */
  repairDiagnostics: string | null;
};

export type GeometryPlannerResult =
  | { ok: true; step: ProceduralStep }
  | { ok: false; gate: 1; diagnostics: string };

// ── Implementation ───────────────────────────────────────────────────────────

/**
 * Runs the geometry planner to generate procedural JSON for one atomic step.
 *
 * Assembles the prompt from the committed scene state, the atomic step goal,
 * and any repair diagnostics, then passes it to the builder model. The raw
 * output is cleaned and validated against `ProceduralStepSchema` (Gate 1).
 *
 * Gate 2 (schema/operation checks) and Gate 3 (vision validation) are handled
 * by the deterministic builder and vision validator respectively — this function
 * only handles Gate 1.
 */
export async function runGeometryPlanner(
  input: GeometryPlannerInput,
  builderConfig: ModelConfig,
  callLlm: LlmCaller,
): Promise<GeometryPlannerResult> {
  const parts: string[] = [];

  parts.push(
    `## Committed Scene State (revision ${input.committedSceneState.revision})\n` +
      "```json\n" +
      JSON.stringify(input.committedSceneState.nodes, null, 2) +
      "\n```",
  );

  parts.push(
    `## Current Atomic Step\n` +
      "```json\n" +
      JSON.stringify(input.currentAtomicStep, null, 2) +
      "\n```",
  );

  if (input.repairDiagnostics !== null) {
    parts.push(
      `## Repair Diagnostics (from previous failed attempt)\n` +
        "Your previous output failed validation. Fix ALL of the following issues:\n\n" +
        input.repairDiagnostics,
    );
  }

  const userContent = parts.join("\n\n");

  const rawResponse = await callLlm({
    config: builderConfig,
    systemPrompt: GEOMETRY_BUILDER_PROMPT,
    userContent,
  });

  // Gate 1: JSON parse + schema validation
  try {
    const cleanedJson = extractCleanJson(rawResponse);
    const parsed = JSON.parse(cleanedJson) as unknown;
    const validated = ProceduralStepSchema.safeParse(parsed);
    if (!validated.success) {
      const issues = validated.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      return {
        ok: false,
        gate: 1,
        diagnostics: `Gate 1 schema validation failed: ${issues}`,
      };
    }
    return { ok: true, step: validated.data };
  } catch (error) {
    return {
      ok: false,
      gate: 1,
      diagnostics: `Gate 1 JSON parse failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
