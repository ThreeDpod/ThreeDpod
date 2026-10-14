/**
 * Multi-model turn state machine pipeline runner.
 *
 * Implements the 11-state lifecycle loop:
 *   `queued` -> `planning_scene` -> (`needs_input` | `planning_geometry` -> `building` -> `verifying` -> `applying` -> `stale` | `completed` | `failed` | `cancelled`)
 *
 * Coordinates:
 *   1. Multimodal Intake & Scene Planning (DeepSeek-R1 / GPT Luna)
 *   2. Procedural Geometry Building (Qwen 2.5 / GPT Luna fallback)
 *   3. 3-Gate Deterministic & Vision Verification (Gates 1, 2, 3)
 *   4. Optimistic concurrency with monotonic revisions in SceneRegistry
 *   5. Real-time WebSocket TurnStreamEvent broadcasting
 */

import type { Env } from "../env.ts";
import { broadcastTurnEvent, type TurnStreamEvent } from "../ws/event-stream.ts";
import { runDeterministicBuilder, type SceneState } from "./deterministic-builder.ts";
import { runGeometryPlanner } from "./geometry-planner.ts";
import { getModelConfigForRole, type ModelRole } from "./model-access.ts";
import type { SceneRegistry, TurnRegistry, ActiveTurn } from "./registry.ts";
import { runMultimodalIntake, runScenePlanner, type LlmCaller } from "./scene-planner.ts";
import type { IntakeIntent, ScenePlanReady } from "./schemas.ts";
import { isTerminal, transition, type TurnContext, type TurnState } from "./state-machine.ts";
import { runVisionValidator } from "./vision-validator.ts";

export type TurnRunnerDeps = {
  env: Env;
  registry: TurnRegistry;
  sceneRegistry: SceneRegistry;
  callLlm: LlmCaller;
  broadcastEvent?: (sessionId: string, event: TurnStreamEvent) => void;
  renderViewportScreenshot?: (candidateScene: SceneState) => Promise<string | null>;
};

export type TurnRunnerInput = {
  turnId: string;
  sessionId: string;
  projectId: string;
  userId: string;
  userMessage: string;
  referenceImages?: string[];
  signal: AbortSignal;
};

export type TurnRunnerResult =
  | { ok: true; finalRevision: number }
  | { ok: false; state: TurnState; error: string };

/**
 * Executes a full turn through the multi-model state machine.
 */
export async function executeTurnStateMachine(
  input: TurnRunnerInput,
  deps: TurnRunnerDeps,
): Promise<TurnRunnerResult> {
  const ctx: TurnContext = {
    turnId: input.turnId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    state: "queued",
    baseRevision: deps.sceneRegistry.getRevision(input.projectId),
    retriesUsed: 0,
    retryBudget: deps.env.TURN_MAX_RETRY_BUDGET,
    rebaseAttempts: 0,
    maxRebaseAttempts: deps.env.TURN_MAX_REBASE_ATTEMPTS,
    currentStepIndex: 0,
    scenePlan: null,
    lastRepairDiagnostics: null,
    signal: input.signal,
  };

  const emit = (event: TurnStreamEvent) => {
    if (deps.broadcastEvent) {
      deps.broadcastEvent(ctx.sessionId, event);
    } else {
      broadcastTurnEvent(ctx.sessionId, event);
    }
  };

  const setState = (nextState: TurnState) => {
    const from = ctx.state;
    ctx.state = transition(ctx.state, nextState);
    deps.registry.updateTurnState(ctx.turnId, ctx.state);
    emit({
      type: "turn.state_changed",
      turnId: ctx.turnId,
      from,
      to: ctx.state,
      timestamp: new Date().toISOString(),
    });
  };

  const activeTurn: ActiveTurn = {
    turnId: ctx.turnId,
    sessionId: ctx.sessionId,
    userId: input.userId,
    projectId: ctx.projectId,
    state: ctx.state,
  };
  deps.registry.registerTurn(activeTurn);

  try {
    // Check initial abort
    if (ctx.signal.aborted) {
      setState("cancelled");
      return { ok: false, state: "cancelled", error: "Turn cancelled before start" };
    }

    let cachedIntakeIntent: IntakeIntent | undefined;
    let clarificationAnswers: string[] = [];

    // Outer rebase/planning loop
    planningLoop: while (true) {
      if (ctx.signal.aborted) {
        setState("cancelled");
        return { ok: false, state: "cancelled", error: "Turn cancelled" };
      }

      setState("planning_scene");

      // Multimodal intake if reference images attached and not yet parsed
      if (
        input.referenceImages !== undefined &&
        input.referenceImages.length > 0 &&
        cachedIntakeIntent === undefined
      ) {
        const intakeConfig = getModelConfigForRole("intake_vision", deps.env);
        const currentSummary = JSON.stringify(deps.sceneRegistry.getScene(ctx.projectId).nodes);
        const intakeRes = await runMultimodalIntake(
          input.referenceImages,
          input.userMessage,
          currentSummary,
          intakeConfig,
          deps.callLlm,
        );
        if (intakeRes.ok) {
          cachedIntakeIntent = intakeRes.intent;
        }
      }

      const committedScene = deps.sceneRegistry.getScene(ctx.projectId);
      ctx.baseRevision = committedScene.revision;

      const plannerConfig = getModelConfigForRole("scene_planner", deps.env);
      const planResult = await runScenePlanner(
        {
          userMessage: input.userMessage,
          clarificationAnswers,
          ...(cachedIntakeIntent !== undefined ? { cachedIntakeIntent } : {}),
          committedSceneSummary: JSON.stringify(committedScene.nodes),
        },
        plannerConfig,
        deps.callLlm,
      );

      if (!planResult.ok) {
        setState("failed");
        emit({ type: "turn.failed", turnId: ctx.turnId, reason: planResult.diagnostics });
        return { ok: false, state: "failed", error: planResult.diagnostics };
      }

      if (planResult.plan.status === "needs_input") {
        setState("needs_input");
        emit({
          type: "turn.needs_input",
          turnId: ctx.turnId,
          ambiguityReason: planResult.plan.ambiguityReason,
          questions: planResult.plan.questionsForUser,
        });

        // Await clarification submission via POST /api/turns/:turnId/clarify or abort
        const answers = await new Promise<string[]>((resolve, reject) => {
          activeTurn.submitClarification = (submittedAnswers: string[]) => {
            resolve(submittedAnswers);
            return true;
          };
          if (ctx.signal.aborted) {
            reject(new Error("Turn aborted while awaiting clarification"));
          }
          ctx.signal.addEventListener(
            "abort",
            () => reject(new Error("Turn aborted while awaiting clarification")),
            { once: true },
          );
        });

        clarificationAnswers = answers;
        // User supplied clarification, loop back to planning_scene
        continue planningLoop;
      }

      // Ready plan received
      const scenePlan = planResult.plan as ScenePlanReady;
      ctx.scenePlan = scenePlan;
      ctx.currentStepIndex = 0;

      emit({
        type: "turn.plan_ready",
        turnId: ctx.turnId,
        sceneSummary: scenePlan.sceneSummary,
        totalSteps: scenePlan.atomicSteps.length,
        steps: scenePlan.atomicSteps.map((s) => ({ stepId: s.stepId, goal: s.goal })),
      });

      setState("planning_geometry");

      // Execution of atomic steps
      stepLoop: while (ctx.currentStepIndex < scenePlan.atomicSteps.length) {
        const step = scenePlan.atomicSteps[ctx.currentStepIndex]!;
        ctx.retriesUsed = 0;
        ctx.lastRepairDiagnostics = null;

        retryLoop: while (true) {
          if (ctx.signal.aborted) {
            setState("cancelled");
            return { ok: false, state: "cancelled", error: "Turn cancelled" };
          }

          // Select builder role: use fallback model on final retry attempt
          const isFinalRetry = ctx.retriesUsed >= ctx.retryBudget - 1;
          const role: ModelRole = isFinalRetry ? "geometry_fallback" : "geometry_builder";
          const builderConfig = getModelConfigForRole(role, deps.env);

          emit({
            type: "turn.step_started",
            turnId: ctx.turnId,
            stepIndex: ctx.currentStepIndex,
            stepId: step.stepId,
            attempt: ctx.retriesUsed + 1,
            model: builderConfig.model,
          });

          // Run Geometry Planner (Gate 1 JSON parse)
          const currentCommitted = deps.sceneRegistry.getScene(ctx.projectId);
          const geomResult = await runGeometryPlanner(
            {
              committedSceneState: {
                nodes: Array.from(currentCommitted.nodes.values()),
                revision: currentCommitted.revision,
              },
              currentAtomicStep: step,
              repairDiagnostics: ctx.lastRepairDiagnostics,
            },
            builderConfig,
            deps.callLlm,
          );

          if (!geomResult.ok) {
            emit({
              type: "turn.gate_result",
              turnId: ctx.turnId,
              stepId: step.stepId,
              attempt: ctx.retriesUsed + 1,
              gate: 1,
              passed: false,
              diagnostics: geomResult.diagnostics,
            });

            if (ctx.retriesUsed + 1 < ctx.retryBudget) {
              ctx.retriesUsed++;
              ctx.lastRepairDiagnostics = geomResult.diagnostics;
              setState("planning_geometry"); // Self-transition retry
              continue retryLoop;
            } else {
              setState("failed");
              emit({
                type: "turn.failed",
                turnId: ctx.turnId,
                stepId: step.stepId,
                reason: `Gate 1 failed after ${ctx.retryBudget} attempts: ${geomResult.diagnostics}`,
              });
              return { ok: false, state: "failed", error: geomResult.diagnostics };
            }
          }

          emit({
            type: "turn.gate_result",
            turnId: ctx.turnId,
            stepId: step.stepId,
            attempt: ctx.retriesUsed + 1,
            gate: 1,
            passed: true,
          });

          setState("building");

          // Gate 2: Deterministic Builder & Operations
          const buildResult = runDeterministicBuilder(currentCommitted, geomResult.step);
          if (!buildResult.ok) {
            emit({
              type: "turn.gate_result",
              turnId: ctx.turnId,
              stepId: step.stepId,
              attempt: ctx.retriesUsed + 1,
              gate: 2,
              passed: false,
              diagnostics: buildResult.diagnostics,
            });

            if (ctx.retriesUsed + 1 < ctx.retryBudget) {
              ctx.retriesUsed++;
              ctx.lastRepairDiagnostics = buildResult.diagnostics;
              setState("planning_geometry");
              continue retryLoop;
            } else {
              setState("failed");
              emit({
                type: "turn.failed",
                turnId: ctx.turnId,
                stepId: step.stepId,
                reason: `Gate 2 failed after ${ctx.retryBudget} attempts: ${buildResult.diagnostics}`,
              });
              return { ok: false, state: "failed", error: buildResult.diagnostics };
            }
          }

          emit({
            type: "turn.gate_result",
            turnId: ctx.turnId,
            stepId: step.stepId,
            attempt: ctx.retriesUsed + 1,
            gate: 2,
            passed: true,
          });

          setState("verifying");

          // Gate 3: Vision Validator
          const screenshotBase64 =
            (await deps.renderViewportScreenshot?.(buildResult.candidateScene)) ?? undefined;
          const visionConfig = getModelConfigForRole("vision_validator", deps.env);
          const visionResult = await runVisionValidator(
            {
              userPrompt: input.userMessage,
              stepGoal: step.goal,
              candidateSceneSummary: JSON.stringify(Array.from(buildResult.candidateScene.nodes.values())),
              ...(screenshotBase64 !== undefined ? { screenshotBase64 } : {}),
            },
            visionConfig,
            deps.callLlm,
          );

          if (!visionResult.ok) {
            emit({
              type: "turn.gate_result",
              turnId: ctx.turnId,
              stepId: step.stepId,
              attempt: ctx.retriesUsed + 1,
              gate: 3,
              passed: false,
              diagnostics: visionResult.diagnostics,
            });

            if (ctx.retriesUsed + 1 < ctx.retryBudget) {
              ctx.retriesUsed++;
              ctx.lastRepairDiagnostics = visionResult.diagnostics;
              setState("planning_geometry");
              continue retryLoop;
            } else {
              setState("failed");
              emit({
                type: "turn.failed",
                turnId: ctx.turnId,
                stepId: step.stepId,
                reason: `Gate 3 failed after ${ctx.retryBudget} attempts: ${visionResult.diagnostics}`,
              });
              return { ok: false, state: "failed", error: visionResult.diagnostics };
            }
          }

          emit({
            type: "turn.gate_result",
            turnId: ctx.turnId,
            stepId: step.stepId,
            attempt: ctx.retriesUsed + 1,
            gate: 3,
            passed: true,
          });

          setState("applying");

          // Optimistic Concurrency Commit to SceneRegistry
          const commit = deps.sceneRegistry.commitCandidate(
            ctx.projectId,
            currentCommitted.revision,
            buildResult.candidateScene,
            { stepId: step.stepId },
          );

          if (commit.status === "stale_base") {
            emit({
              type: "turn.stale_rebase",
              turnId: ctx.turnId,
              expectedRevision: currentCommitted.revision,
              actualRevision: commit.currentRevision,
              rebaseAttempt: ctx.rebaseAttempts + 1,
            });

            if (ctx.rebaseAttempts + 1 < ctx.maxRebaseAttempts) {
              ctx.rebaseAttempts++;
              setState("stale");
              continue planningLoop; // Re-reads scene state and replans
            } else {
              setState("failed");
              emit({
                type: "turn.failed",
                turnId: ctx.turnId,
                stepId: step.stepId,
                reason: "Max rebase attempts reached due to concurrent base revision conflicts",
              });
              return { ok: false, state: "failed", error: "Max rebase attempts reached" };
            }
          }

          // Step committed successfully
          emit({
            type: "turn.step_committed",
            turnId: ctx.turnId,
            stepIndex: ctx.currentStepIndex,
            stepId: step.stepId,
            newRevision: commit.newRevision,
            sceneDelta: geomResult.step,
          });

          if (ctx.currentStepIndex + 1 < scenePlan.atomicSteps.length) {
            ctx.currentStepIndex++;
            setState("planning_geometry");
            break retryLoop;
          } else {
            // All steps completed!
            setState("completed");
            emit({
              type: "turn.completed",
              turnId: ctx.turnId,
              finalRevision: commit.newRevision,
            });
            return { ok: true, finalRevision: commit.newRevision };
          }
        }
      }
    }
  } catch (err) {
    if (ctx.signal.aborted) {
      if (!isTerminal(ctx.state)) setState("cancelled");
      return { ok: false, state: "cancelled", error: "Turn cancelled" };
    }
    const message = err instanceof Error ? err.message : String(err);
    if (!isTerminal(ctx.state)) {
      setState("failed");
      emit({ type: "turn.failed", turnId: ctx.turnId, reason: message });
    }
    return { ok: false, state: "failed", error: message };
  } finally {
    deps.registry.unregisterTurn(ctx.turnId);
  }
}
