import { describe, expect, it } from "vitest";
import type { ModelConfig } from "./model-access.ts";
import { runMultimodalIntake, runScenePlanner, type ScenePlannerInput } from "./scene-planner.ts";

const INTAKE_CONFIG: ModelConfig = {
  model: "openai/gpt-5.6-luna",
  temperature: 0.2,
  maxTokens: 1500,
};

const PLANNER_CONFIG: ModelConfig = {
  model: "deepseek/deepseek-r1",
  temperature: 0.6,
  maxTokens: 4096,
};

describe("runMultimodalIntake", () => {
  it("parses reference images and user request into structured IntakeIntent", async () => {
    const mockLlm = async () =>
      JSON.stringify({
        parsedIntent: "Construct an articulated mug-mounted cookie holder",
        extractedProportions: {
          overallWidthMeters: 0.18,
          overallHeightMeters: 0.22,
          overallDepthMeters: 0.14,
        },
        identifiedParts: [
          { partName: "mug_body", primitiveHint: "cylinder", materialHint: "cream ceramic" },
        ],
        missingConstraints: [],
      });

    const result = await runMultimodalIntake(["base64img"], "build this", "empty scene", INTAKE_CONFIG, mockLlm);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent.parsedIntent).toBe("Construct an articulated mug-mounted cookie holder");
      expect(result.intent.identifiedParts).toHaveLength(1);
    }
  });

  it("handles markdown and think blocks in intake response", async () => {
    const mockLlm = async () =>
      "<think>parsing image</think>\n```json\n" +
      JSON.stringify({
        parsedIntent: "A simple sphere",
        extractedProportions: {
          overallWidthMeters: 1,
          overallHeightMeters: 1,
          overallDepthMeters: 1,
        },
        identifiedParts: [],
        missingConstraints: [],
      }) +
      "\n```";

    const result = await runMultimodalIntake(["base64img"], "build sphere", "empty", INTAKE_CONFIG, mockLlm);
    expect(result.ok).toBe(true);
  });
});

describe("runScenePlanner", () => {
  it("returns ready plan with atomic steps when prompt is unambiguous", async () => {
    const mockLlm = async () =>
      JSON.stringify({
        status: "ready",
        sceneSummary: "A wooden office desk with 4 legs",
        atomicSteps: [
          {
            stepIndex: 0,
            stepId: "desk_frame",
            goal: "Build tabletop and legs",
            targetNodes: ["tabletop", "leg_1"],
            spatialConstraints: ["grounded_on_floor"],
          },
        ],
      });

    const input: ScenePlannerInput = {
      userMessage: "Build an office desk",
      committedSceneSummary: "empty scene",
    };

    const result = await runScenePlanner(input, PLANNER_CONFIG, mockLlm);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.status).toBe("ready");
      if (result.plan.status === "ready") {
        expect(result.plan.atomicSteps).toHaveLength(1);
        expect(result.plan.atomicSteps[0]?.stepId).toBe("desk_frame");
      }
    }
  });

  it("returns needs_input when ambiguity blocks planning", async () => {
    const mockLlm = async () =>
      JSON.stringify({
        status: "needs_input",
        ambiguityReason: "Table dimensions are unspecified",
        questionsForUser: ["What dimensions in meters should the table be?"],
      });

    const input: ScenePlannerInput = {
      userMessage: "Resize table",
      committedSceneSummary: "empty scene",
    };

    const result = await runScenePlanner(input, PLANNER_CONFIG, mockLlm);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.status).toBe("needs_input");
      if (result.plan.status === "needs_input") {
        expect(result.plan.ambiguityReason).toContain("dimensions are unspecified");
        expect(result.plan.questionsForUser).toHaveLength(1);
      }
    }
  });

  it("fails if planner output is invalid JSON", async () => {
    const mockLlm = async () => "Not valid JSON";
    const input: ScenePlannerInput = {
      userMessage: "Build desk",
      committedSceneSummary: "empty",
    };

    const result = await runScenePlanner(input, PLANNER_CONFIG, mockLlm);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toContain("could not be parsed as JSON");
    }
  });
});
