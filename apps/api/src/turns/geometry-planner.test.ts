import { describe, expect, it } from "vitest";
import type { ModelConfig } from "./model-access.ts";
import { runGeometryPlanner, type GeometryPlannerInput } from "./geometry-planner.ts";

const BUILDER_CONFIG: ModelConfig = {
  model: "qwen/qwen-2.5-coder-32b-instruct",
  temperature: 0.1,
  maxTokens: 2500,
  responseFormat: { type: "json_object" },
};

const BASE_INPUT: GeometryPlannerInput = {
  committedSceneState: { nodes: [], revision: 0 },
  currentAtomicStep: {
    stepIndex: 0,
    stepId: "desk_legs",
    goal: "Build 4 legs",
    targetNodes: ["leg_1"],
    spatialConstraints: ["grounded_on_floor"],
  },
  repairDiagnostics: null,
};

describe("runGeometryPlanner", () => {
  it("parses valid ProceduralStep output from builder", async () => {
    const mockLlm = async () =>
      JSON.stringify({
        stepId: "desk_legs",
        intentSummary: "Build desk legs",
        operations: [
          {
            op: "create_node",
            nodeId: "leg_1",
            label: "Leg 1",
            nodeType: "mesh",
            parentId: null,
            geometry: { kind: "cylinder", radiusTop: 0.02, radiusBottom: 0.02, height: 0.72 },
            material: { color: "#8b5a2b" },
            transform: { position: [0, 0.36, 0] },
          },
        ],
        assertions: [],
      });

    const result = await runGeometryPlanner(BASE_INPUT, BUILDER_CONFIG, mockLlm);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.step.stepId).toBe("desk_legs");
      expect(result.step.operations).toHaveLength(1);
    }
  });

  it("fails Gate 1 if output is not valid JSON", async () => {
    const mockLlm = async () => "Not json";
    const result = await runGeometryPlanner(BASE_INPUT, BUILDER_CONFIG, mockLlm);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gate).toBe(1);
      expect(result.diagnostics).toContain("Gate 1 JSON parse failed");
    }
  });

  it("fails Gate 1 if output fails ProceduralStepSchema", async () => {
    const mockLlm = async () => JSON.stringify({ stepId: "foo", operations: [] }); // operations min(1)
    const result = await runGeometryPlanner(BASE_INPUT, BUILDER_CONFIG, mockLlm);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gate).toBe(1);
      expect(result.diagnostics).toContain("Gate 1 schema validation failed");
    }
  });

  it("includes repairDiagnostics in the prompt when retrying", async () => {
    let capturedPrompt = "";
    const mockLlm = async (opts: { userContent: unknown }) => {
      capturedPrompt = String(opts.userContent);
      return JSON.stringify({
        stepId: "desk_legs",
        intentSummary: "Fixed legs",
        operations: [
          {
            op: "create_node",
            nodeId: "leg_1",
            label: "Leg 1",
            nodeType: "mesh",
            parentId: null,
            geometry: { kind: "box", width: 0.1, height: 0.7, depth: 0.1 },
            material: { color: "#ffffff" },
          },
        ],
        assertions: [],
      });
    };

    const inputWithRepair: GeometryPlannerInput = {
      ...BASE_INPUT,
      repairDiagnostics: "Node 'leg_1' overlaps 'tabletop'",
    };

    const result = await runGeometryPlanner(inputWithRepair, BUILDER_CONFIG, mockLlm);
    expect(result.ok).toBe(true);
    expect(capturedPrompt).toContain("Repair Diagnostics (from previous failed attempt)");
    expect(capturedPrompt).toContain("Node 'leg_1' overlaps 'tabletop'");
  });
});
