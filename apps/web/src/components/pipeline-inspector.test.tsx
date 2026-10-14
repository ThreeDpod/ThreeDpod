import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TurnPlan } from "../hooks/use-turn-stream.ts";
import { PipelineInspector } from "./pipeline-inspector.tsx";

describe("PipelineInspector", () => {
  const samplePlan: TurnPlan = {
    sceneSummary: "Modern minimalist coffee table",
    totalSteps: 2,
    steps: [
      {
        stepIndex: 0,
        stepId: "step_0",
        goal: "Build round tabletop",
        status: "committed",
        attempt: 1,
        activeModel: "qwen/qwen-2.5-coder-32b-instruct",
        gates: {
          1: { passed: true },
          2: { passed: true },
          3: { passed: true },
        },
        history: [],
      },
      {
        stepIndex: 1,
        stepId: "step_1",
        goal: "Assemble 3 tripod legs",
        status: "active",
        attempt: 2,
        activeModel: "qwen/qwen-2.5-coder-32b-instruct",
        gates: {
          1: { passed: true },
          2: { passed: false, diagnostics: "Legs overlap with floor plane" },
          3: null,
        },
        history: [
          {
            attempt: 1,
            model: "qwen/qwen-2.5-coder-32b-instruct",
            gates: {
              1: { passed: false, diagnostics: "Syntax error on line 12" },
              2: null,
              3: null,
            },
          },
        ],
      },
    ],
  };

  it("renders the active state badge and agent display for planning_scene", () => {
    render(
      <PipelineInspector
        currentState="planning_scene"
        plan={null}
        rebaseAlert={null}
      />,
    );

    expect(screen.getByText("planning scene")).toBeInTheDocument();
    expect(screen.getByText("Thinker · DeepSeek-R1")).toBeInTheDocument();
  });

  it("renders active agent for geometry builder and fallback model", () => {
    const { rerender } = render(
      <PipelineInspector
        currentState="planning_geometry"
        plan={null}
        rebaseAlert={null}
        activeModel="qwen/qwen-2.5-coder-32b-instruct"
      />,
    );
    expect(screen.getByText("Builder · Qwen 2.5 Coder")).toBeInTheDocument();

    rerender(
      <PipelineInspector
        currentState="planning_geometry"
        plan={null}
        rebaseAlert={null}
        activeModel="openai/gpt-5.6-luna"
      />,
    );
    expect(screen.getByText("Fallback · GPT-5.6 Luna")).toBeInTheDocument();
  });

  it("renders deterministic builder and vision validator agents", () => {
    const { rerender } = render(
      <PipelineInspector
        currentState="building"
        plan={null}
        rebaseAlert={null}
      />,
    );
    expect(
      screen.getByText("Deterministic Builder (AABB & Schema)"),
    ).toBeInTheDocument();

    rerender(
      <PipelineInspector
        currentState="verifying"
        plan={null}
        rebaseAlert={null}
      />,
    );
    expect(
      screen.getByText("Vision Validator · GPT-5.6 Luna"),
    ).toBeInTheDocument();
  });

  it("renders atomic steps with goals and gate evaluation badges", () => {
    render(
      <PipelineInspector
        currentState="verifying"
        plan={samplePlan}
        rebaseAlert={null}
      />,
    );

    expect(screen.getByText("Build round tabletop")).toBeInTheDocument();
    expect(screen.getByText("Assemble 3 tripod legs")).toBeInTheDocument();
    expect(screen.getByText("Attempt 2/3")).toBeInTheDocument();

    // Check gate labels
    expect(
      screen.getAllByLabelText("Gate 1 (Gate 1: JSON): passed").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getByLabelText("Gate 2 (Gate 2: Schema + AABB): failed"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Gate 3 (Gate 3: Vision): pending"),
    ).toBeInTheDocument();
  });

  it("expands repair diagnostics to inspect previous and current gate failures", () => {
    render(
      <PipelineInspector
        currentState="planning_geometry"
        plan={samplePlan}
        rebaseAlert={null}
      />,
    );

    const inspectButton = screen.getByRole("button", {
      name: /Inspect Repair Diagnostics/,
    });
    expect(inspectButton).toBeInTheDocument();

    fireEvent.click(inspectButton);

    // Diagnostics from attempt 1
    expect(
      screen.getByText(/Syntax error on line 12/),
    ).toBeInTheDocument();
    // Diagnostics from current attempt
    expect(
      screen.getByText(/Legs overlap with floor plane/),
    ).toBeInTheDocument();
  });

  it("renders stale base rebase banner", () => {
    render(
      <PipelineInspector
        currentState="stale"
        plan={samplePlan}
        rebaseAlert={{
          turnId: "t-1",
          expectedRevision: 3,
          actualRevision: 5,
          rebaseAttempt: 1,
        }}
      />,
    );

    expect(
      screen.getByText(/Live edit detected \(Revision #3 → #5\)/),
    ).toBeInTheDocument();
  });

  it("renders error message on failure", () => {
    render(
      <PipelineInspector
        currentState="failed"
        plan={samplePlan}
        rebaseAlert={null}
        error={{
          reason: "Max retries exceeded on Gate 2",
          stepId: "step_1",
        }}
      />,
    );

    expect(
      screen.getByText(/Max retries exceeded on Gate 2/),
    ).toBeInTheDocument();
    expect(screen.getByText(/\(Step: step_1\)/)).toBeInTheDocument();
  });
});
