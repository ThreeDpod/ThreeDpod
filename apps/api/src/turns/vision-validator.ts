/**
 * Gate 3 Vision Validator: verifies rendered candidate scenes.
 *
 * Inspects rendered viewport screenshots of an isolated candidate 3D scene
 * after an atomic build step using the ORCHESTRATOR_VISION_MODEL (GPT Luna)
 * and VISION_VALIDATOR_PROMPT.
 *
 * Emits raw JSON conforming to VisionAssessmentSchema. If accepted is false,
 * returns { ok: false, gate: 3, diagnostics: targetedRevisionRequest }
 * for targeted repair by the Geometry Planner on retry.
 */

import type { ModelConfig } from "./model-access.ts";
import { extractCleanJson } from "./model-access.ts";
import { VisionAssessmentSchema, type VisionAssessment } from "./schemas.ts";
import { VISION_VALIDATOR_PROMPT } from "./prompts.ts";
import type { LlmCaller } from "./scene-planner.ts";

export type VisionValidatorInput = {
  /** The original prompt from the user for the entire turn. */
  userPrompt: string;
  /** The goal of the specific atomic step being validated. */
  stepGoal: string;
  /** Structural summary of the candidate scene nodes and hierarchy. */
  candidateSceneSummary: string;
  /** Base64 PNG viewport capture of the rendered candidate scene. */
  screenshotBase64?: string;
};

export type VisionValidatorResult =
  | { ok: true; assessment: VisionAssessment }
  | { ok: false; gate: 3; diagnostics: string };

/**
 * Runs Gate 3 vision validation on an isolated candidate scene.
 *
 * Passes the overall prompt, atomic step goal, candidate hierarchy, and
 * rendered screenshot (if available) to the vision validator model.
 * If rejected, formats `targetedRevisionRequest` as Gate 3 diagnostics.
 */
export async function runVisionValidator(
  input: VisionValidatorInput,
  validatorConfig: ModelConfig,
  callLlm: LlmCaller,
): Promise<VisionValidatorResult> {
  const parts: string[] = [];
  parts.push(`## Overall User Prompt\n${input.userPrompt}`);
  parts.push(`## Atomic Step Goal\n${input.stepGoal}`);
  parts.push(`## Candidate Scene Hierarchy Summary\n${input.candidateSceneSummary}`);

  const userContent:
    | string
    | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> =
    input.screenshotBase64 !== undefined && input.screenshotBase64.length > 0
      ? [
          { type: "text", text: parts.join("\n\n") },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${input.screenshotBase64}` },
          },
        ]
      : parts.join("\n\n");

  const rawResponse = await callLlm({
    config: validatorConfig,
    systemPrompt: VISION_VALIDATOR_PROMPT,
    userContent,
  });

  try {
    const cleanedJson = extractCleanJson(rawResponse);
    const parsed = JSON.parse(cleanedJson) as unknown;
    const validated = VisionAssessmentSchema.safeParse(parsed);
    if (!validated.success) {
      return {
        ok: false,
        gate: 3,
        diagnostics: `Vision assessment failed schema validation: ${validated.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      };
    }

    if (!validated.data.accepted) {
      return {
        ok: false,
        gate: 3,
        diagnostics:
          validated.data.targetedRevisionRequest ??
          "Candidate rejected by vision validator without specific revision request.",
      };
    }

    return { ok: true, assessment: validated.data };
  } catch (error) {
    return {
      ok: false,
      gate: 3,
      diagnostics: `Vision assessment output could not be parsed as JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
