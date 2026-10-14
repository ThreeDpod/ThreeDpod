/**
 * Scene planner: the `planning_scene` stage of the turn pipeline.
 *
 * Orchestrates two model calls in sequence when reference images are present,
 * or a single call when the request is text-only:
 *
 *   1. **Multimodal intake** (GPT Luna, optional) — parses user images into
 *      structured intent: dimensions, part hierarchy, primitives, materials.
 *   2. **Scene planning** (DeepSeek-R1) — evaluates sufficiency, detects
 *      ambiguity, and decomposes the request into ordered atomic steps.
 *
 * The planner is a pure function of its inputs — it takes the model-calling
 * function as a dependency rather than reaching for a client, so it is testable
 * without a running OpenRouter account.
 *
 * The result is one of three things:
 *   - A validated `ScenePlanReady` with atomic steps to execute.
 *   - A `needs_input` result asking the user for clarification.
 *   - A `failed` result if the model output could not be parsed or validated.
 */

import type { ModelConfig } from "./model-access.ts";
import { extractCleanJson } from "./model-access.ts";
import {
  IntakeIntentSchema,
  ScenePlanOutputSchema,
  type IntakeIntent,
  type ScenePlanOutput,
} from "./schemas.ts";
import { INTAKE_VISION_PROMPT, SCENE_PLANNER_PROMPT } from "./prompts.ts";

// ── Types ────────────────────────────────────────────────────────────────────

/** What the caller hands in for a planning request. */
export type ScenePlannerInput = {
  /** The user's natural language request. */
  userMessage: string;
  /** Any clarification answers from a previous `needs_input` round. */
  clarificationAnswers?: string[];
  /** Base64-encoded reference images, if the user attached any. */
  referenceImages?: string[];
  /** A JSON summary of the current committed scene state. */
  committedSceneSummary: string;
  /** Previously extracted multimodal intent, to avoid re-running intake on rebase. */
  cachedIntakeIntent?: IntakeIntent;
};

/**
 * A function that calls an LLM and returns the raw text response.
 *
 * Injected rather than imported so the planner is testable with a stub, and
 * so the caller controls retry logic, timeouts, and abort signals.
 */
export type LlmCaller = (options: {
  config: ModelConfig;
  systemPrompt: string;
  userContent: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
}) => Promise<string>;

export type ScenePlannerResult =
  | { ok: true; plan: ScenePlanOutput }
  | { ok: false; diagnostics: string };

// ── Implementation ───────────────────────────────────────────────────────────

/**
 * Runs multimodal intake on reference images to extract structured intent.
 *
 * Only called when the user attached images. The result is cached on the
 * `TurnContext` so a rebase does not re-run this expensive vision call.
 */
export async function runMultimodalIntake(
  images: string[],
  userMessage: string,
  sceneSummary: string,
  intakeConfig: ModelConfig,
  callLlm: LlmCaller,
): Promise<{ ok: true; intent: IntakeIntent } | { ok: false; diagnostics: string }> {
  const userContent: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
    { type: "text", text: `User request: ${userMessage}\n\nCurrent scene summary:\n${sceneSummary}` },
    ...images.map((img) => ({
      type: "image_url" as const,
      image_url: { url: `data:image/png;base64,${img}` },
    })),
  ];

  const rawResponse = await callLlm({
    config: intakeConfig,
    systemPrompt: INTAKE_VISION_PROMPT,
    userContent,
  });

  try {
    const cleanedJson = extractCleanJson(rawResponse);
    const parsed = JSON.parse(cleanedJson) as unknown;
    const validated = IntakeIntentSchema.safeParse(parsed);
    if (!validated.success) {
      return {
        ok: false,
        diagnostics: `Intake output failed schema validation: ${validated.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      };
    }
    return { ok: true, intent: validated.data };
  } catch (error) {
    return {
      ok: false,
      diagnostics: `Intake output could not be parsed as JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Runs the scene planner (DeepSeek-R1) to decompose the request into atomic steps.
 *
 * Assembles the user prompt from the request, any clarification answers, optional
 * multimodal intent, and the committed scene state, then passes everything to the
 * planner model. The raw output is cleaned of `<think>` blocks and validated
 * against `ScenePlanOutputSchema`.
 */
export async function runScenePlanner(
  input: ScenePlannerInput,
  plannerConfig: ModelConfig,
  callLlm: LlmCaller,
): Promise<ScenePlannerResult> {
  const parts: string[] = [];

  parts.push(`## User Request\n${input.userMessage}`);

  if (input.clarificationAnswers !== undefined && input.clarificationAnswers.length > 0) {
    parts.push(`## Clarification Answers\n${input.clarificationAnswers.map((a, i) => `${i + 1}. ${a}`).join("\n")}`);
  }

  if (input.cachedIntakeIntent !== undefined) {
    parts.push(`## Extracted Multimodal Intent\n${JSON.stringify(input.cachedIntakeIntent, null, 2)}`);
  }

  parts.push(`## Committed Scene State\n${input.committedSceneSummary}`);

  const userContent = parts.join("\n\n");

  const rawResponse = await callLlm({
    config: plannerConfig,
    systemPrompt: SCENE_PLANNER_PROMPT,
    userContent,
  });

  try {
    const cleanedJson = extractCleanJson(rawResponse);
    const parsed = JSON.parse(cleanedJson) as unknown;
    const validated = ScenePlanOutputSchema.safeParse(parsed);
    if (!validated.success) {
      return {
        ok: false,
        diagnostics: `Scene plan output failed schema validation: ${validated.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      };
    }
    return { ok: true, plan: validated.data };
  } catch (error) {
    return {
      ok: false,
      diagnostics: `Scene plan output could not be parsed as JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
