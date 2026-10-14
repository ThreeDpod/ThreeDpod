import { describe, expect, it } from "vitest";
import type { ModelConfig } from "./model-access.ts";
import { runVisionValidator, type VisionValidatorInput } from "./vision-validator.ts";

const MOCK_CONFIG: ModelConfig = {
  model: "openai/gpt-5.6-luna",
  temperature: 0.0,
  maxTokens: 1024,
  responseFormat: { type: "json_object" },
};

const BASE_INPUT: VisionValidatorInput = {
  userPrompt: "Build a wooden desk",
  stepGoal: "Create the desk tabletop and 4 legs",
  candidateSceneSummary: "group: desk (mesh: tabletop, mesh: leg_1, leg_2, leg_3, leg_4)",
  screenshotBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
};

describe("runVisionValidator", () => {
  it("accepts candidate when vision assessment passes", async () => {
    const mockLlm = async () =>
      JSON.stringify({
        accepted: true,
        score: 95,
        observedIssues: [],
        targetedRevisionRequest: null,
      });

    const result = await runVisionValidator(BASE_INPUT, MOCK_CONFIG, mockLlm);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.assessment.accepted).toBe(true);
      expect(result.assessment.score).toBe(95);
      expect(result.assessment.observedIssues).toEqual([]);
    }
  });

  it("fails Gate 3 when vision assessment rejects candidate with targeted revision request", async () => {
    const mockLlm = async () =>
      JSON.stringify({
        accepted: false,
        score: 42,
        observedIssues: ["Leg 2 is floating above the floor"],
        targetedRevisionRequest: "Adjust leg_2 transform.position[1] downward by 0.15m so it contacts floor",
      });

    const result = await runVisionValidator(BASE_INPUT, MOCK_CONFIG, mockLlm);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gate).toBe(3);
      expect(result.diagnostics).toContain("Adjust leg_2 transform.position[1]");
    }
  });

  it("handles markdown fences and <think> blocks in LLM output", async () => {
    const mockLlm = async () =>
      "<think>Evaluating desk legs...</think>\n```json\n" +
      JSON.stringify({
        accepted: true,
        score: 90,
        observedIssues: [],
        targetedRevisionRequest: null,
      }) +
      "\n```";

    const result = await runVisionValidator(BASE_INPUT, MOCK_CONFIG, mockLlm);
    expect(result.ok).toBe(true);
  });

  it("fails Gate 3 if LLM returns invalid JSON", async () => {
    const mockLlm = async () => "Not valid JSON at all";

    const result = await runVisionValidator(BASE_INPUT, MOCK_CONFIG, mockLlm);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gate).toBe(3);
      expect(result.diagnostics).toContain("could not be parsed as JSON");
    }
  });

  it("fails Gate 3 if LLM output fails schema validation", async () => {
    const mockLlm = async () => JSON.stringify({ score: "not-a-number" });

    const result = await runVisionValidator(BASE_INPUT, MOCK_CONFIG, mockLlm);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gate).toBe(3);
      expect(result.diagnostics).toContain("failed schema validation");
    }
  });
});
