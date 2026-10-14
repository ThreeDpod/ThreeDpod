"use client";

/**
 * Pipeline Telemetry & 3-Gate Inspector UI.
 *
 * Visualizes the multi-agent 11-state turn execution in real-time:
 * 1. Current State & Active Agent header (DeepSeek-R1, Qwen 2.5 Coder,
 *    Deterministic Builder, Vision Validator GPT-5.6 Luna, or Fallback Luna).
 * 2. Ordered Atomic Step decomposition checklist with inline 3-gate verification:
 *    - Gate 1: JSON Parse
 *    - Gate 2: Schema & AABB Spatial Constraints
 *    - Gate 3: Vision Validator Assessment
 * 3. Expandable repair diagnostics history for retry inspection.
 * 4. Stale Base Rebase notification banner.
 */

import { useState } from "react";
import type {
  GateEvaluation,
  GateNumber,
  RebaseAlert,
  StepPlanItem,
  TurnPlan,
  TurnState,
} from "../hooks/use-turn-stream.ts";

export type PipelineInspectorProps = {
  currentState: TurnState | null;
  plan: TurnPlan | null;
  rebaseAlert: RebaseAlert | null;
  activeModel?: string | null;
  error?: { reason: string; stepId?: string } | null;
  className?: string;
};

/**
 * Resolves the display label and color styling for an active agent role.
 */
function getAgentDisplay(state: TurnState | null, activeModel?: string | null) {
  switch (state) {
    case "planning_scene":
      return {
        label: "Thinker · DeepSeek-R1",
        badgeClass: "bg-indigo-500/20 text-indigo-300 border-indigo-500/30",
      };
    case "planning_geometry":
      if (activeModel && (activeModel.includes("luna") || activeModel.includes("gpt"))) {
        return {
          label: "Fallback · GPT-5.6 Luna",
          badgeClass: "bg-orange-500/20 text-orange-300 border-orange-500/30",
        };
      }
      return {
        label: "Builder · Qwen 2.5 Coder",
        badgeClass: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
      };
    case "building":
      return {
        label: "Deterministic Builder (AABB & Schema)",
        badgeClass: "bg-teal-500/20 text-teal-300 border-teal-500/30",
      };
    case "verifying":
      return {
        label: "Vision Validator · GPT-5.6 Luna",
        badgeClass: "bg-purple-500/20 text-purple-300 border-purple-500/30",
      };
    case "applying":
      return {
        label: "Scene Registry · Committing",
        badgeClass: "bg-blue-500/20 text-blue-300 border-blue-500/30",
      };
    case "needs_input":
      return {
        label: "Awaiting Clarification",
        badgeClass: "bg-amber-500/20 text-amber-300 border-amber-500/30",
      };
    case "stale":
      return {
        label: "Rebasing & Replanning",
        badgeClass: "bg-amber-500/20 text-amber-300 border-amber-500/30",
      };
    case "completed":
      return {
        label: "All Steps Completed",
        badgeClass: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
      };
    case "failed":
      return {
        label: "Pipeline Failed",
        badgeClass: "bg-red-500/20 text-red-300 border-red-500/30",
      };
    case "cancelled":
      return {
        label: "Turn Cancelled",
        badgeClass: "bg-neutral-500/20 text-neutral-400 border-neutral-500/30",
      };
    case "queued":
      return {
        label: "Queued",
        badgeClass: "bg-neutral-500/20 text-neutral-300 border-neutral-500/30",
      };
    default:
      return null;
  }
}

function getStateBadgeClass(state: TurnState | null) {
  switch (state) {
    case "completed":
      return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
    case "failed":
      return "bg-red-500/15 text-red-400 border-red-500/30";
    case "cancelled":
      return "bg-neutral-800 text-neutral-400 border-neutral-700";
    case "needs_input":
    case "stale":
      return "bg-amber-500/15 text-amber-400 border-amber-500/30 animate-pulse";
    default:
      return "bg-sky-500/15 text-sky-400 border-sky-500/30 animate-pulse";
  }
}

function GateBadge({
  gate,
  label,
  evaluation,
}: {
  gate: GateNumber;
  label: string;
  evaluation: GateEvaluation | null;
}) {
  if (evaluation === null) {
    return (
      <span
        aria-label={`Gate ${gate} (${label}): pending`}
        className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium border border-neutral-800 bg-neutral-900/60 text-neutral-500"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-neutral-600" />
        {label}
      </span>
    );
  }

  if (evaluation.passed) {
    return (
      <span
        aria-label={`Gate ${gate} (${label}): passed`}
        className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium border border-emerald-500/30 bg-emerald-950/40 text-emerald-300"
      >
        <span className="text-emerald-400">✓</span>
        {label}
      </span>
    );
  }

  return (
    <span
      aria-label={`Gate ${gate} (${label}): failed`}
      className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium border border-red-500/30 bg-red-950/40 text-red-300"
    >
      <span className="text-red-400">✗</span>
      {label}
    </span>
  );
}

function StepItemRow({ step }: { step: StepPlanItem }) {
  const [expanded, setExpanded] = useState(false);

  // Check if any gate on any attempt has diagnostics
  const hasDiagnostics =
    step.history.some((h) =>
      Object.values(h.gates).some((g) => g && g.diagnostics),
    ) ||
    Object.values(step.gates).some((g) => g && g.diagnostics);

  const statusColor =
    step.status === "committed"
      ? "text-emerald-400"
      : step.status === "failed"
        ? "text-red-400"
        : step.status === "active"
          ? "text-sky-400"
          : "text-neutral-500";

  return (
    <div className="rounded-lg border border-neutral-800/80 bg-neutral-900/40 p-3 transition-colors hover:border-neutral-700">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`font-mono text-xs font-semibold ${statusColor}`}
          >
            #{step.stepIndex + 1}
          </span>
          <span className="text-sm font-medium text-neutral-200 truncate">
            {step.goal}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {step.attempt > 0 && (
            <span className="text-[11px] font-medium text-neutral-400 bg-neutral-800/60 rounded px-1.5 py-0.5">
              Attempt {step.attempt}/3
            </span>
          )}

          <div className="flex items-center gap-1.5">
            <GateBadge gate={1} label="Gate 1: JSON" evaluation={step.gates[1]} />
            <GateBadge
              gate={2}
              label="Gate 2: Schema + AABB"
              evaluation={step.gates[2]}
            />
            <GateBadge
              gate={3}
              label="Gate 3: Vision"
              evaluation={step.gates[3]}
            />
          </div>
        </div>
      </div>

      {hasDiagnostics && (
        <div className="mt-2 pt-2 border-t border-neutral-800/60">
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="text-[11px] font-medium text-amber-400 hover:text-amber-300 flex items-center gap-1 transition-colors"
          >
            <span>{expanded ? "▾ Hide" : "▸ Inspect"} Repair Diagnostics</span>
          </button>

          {expanded && (
            <div className="mt-2 space-y-2 rounded-md bg-neutral-950/80 p-2.5 text-xs font-mono text-neutral-300 border border-neutral-800">
              {step.history.map((hist, hIdx) => (
                <div key={`hist-${hIdx}`} className="space-y-1">
                  <div className="text-[10px] uppercase tracking-wider text-neutral-500">
                    Attempt {hist.attempt} {hist.model ? `(${hist.model})` : ""}:
                  </div>
                  {Object.entries(hist.gates).map(([gNum, gEval]) =>
                    gEval?.diagnostics ? (
                      <div
                        key={`g-${gNum}`}
                        className="pl-2 border-l-2 border-red-500/50 text-red-300 text-[11px] whitespace-pre-wrap"
                      >
                        Gate {gNum}: {gEval.diagnostics}
                      </div>
                    ) : null,
                  )}
                </div>
              ))}

              {Object.entries(step.gates).map(([gNum, gEval]) =>
                gEval?.diagnostics ? (
                  <div key={`current-g-${gNum}`} className="space-y-1">
                    <div className="text-[10px] uppercase tracking-wider text-neutral-500">
                      Current Attempt ({step.attempt}):
                    </div>
                    <div className="pl-2 border-l-2 border-red-500/50 text-red-300 text-[11px] whitespace-pre-wrap">
                      Gate {gNum}: {gEval.diagnostics}
                    </div>
                  </div>
                ) : null,
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function PipelineInspector({
  currentState,
  plan,
  rebaseAlert,
  activeModel,
  error,
  className = "",
}: PipelineInspectorProps) {
  const agent = getAgentDisplay(currentState, activeModel);

  return (
    <div
      role="region"
      aria-label="Pipeline Telemetry & Verification Gates"
      className={`rounded-xl border border-neutral-800 bg-neutral-950/80 p-4 shadow-xl backdrop-blur-md ${className}`}
    >
      {/* Header: Turn State & Active Model */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-neutral-800/80">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
            Pipeline:
          </span>
          {currentState && (
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize ${getStateBadgeClass(
                currentState,
              )}`}
            >
              {currentState.replace("_", " ")}
            </span>
          )}
        </div>

        {agent && (
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-neutral-400 font-medium">
              Active Agent:
            </span>
            <span
              className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${agent.badgeClass}`}
            >
              {agent.label}
            </span>
          </div>
        )}
      </div>

      {/* Stale Base Rebase Banner */}
      {rebaseAlert && (
        <div
          role="status"
          className="my-3 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-950/20 px-3 py-2 text-xs text-amber-200"
        >
          <span className="animate-spin text-amber-400">⟳</span>
          <span>
            Live edit detected (Revision #{rebaseAlert.expectedRevision} → #
            {rebaseAlert.actualRevision}). Re-reading scene and replanning...
          </span>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div
          role="alert"
          className="my-3 rounded-lg border border-red-500/40 bg-red-950/30 px-3 py-2 text-xs text-red-200"
        >
          <span className="font-semibold text-red-300">Failure: </span>
          {error.reason} {error.stepId ? `(Step: ${error.stepId})` : ""}
        </div>
      )}

      {/* Atomic Steps Checklist */}
      {plan && plan.steps.length > 0 ? (
        <div className="mt-3 space-y-2">
          <div className="flex items-center justify-between text-xs text-neutral-400 mb-1">
            <span className="font-medium">
              Atomic Steps ({plan.steps.filter((s) => s.status === "committed").length}/
              {plan.totalSteps})
            </span>
            <span className="italic text-neutral-500 truncate max-w-[240px]">
              {plan.sceneSummary}
            </span>
          </div>

          <div className="space-y-2">
            {plan.steps.map((step) => (
              <StepItemRow key={step.stepId} step={step} />
            ))}
          </div>
        </div>
      ) : (
        <div className="py-4 text-center text-xs text-neutral-500">
          {currentState === "queued" || currentState === "planning_scene"
            ? "Decomposing scene into atomic steps..."
            : "No active construction plan."}
        </div>
      )}
    </div>
  );
}
