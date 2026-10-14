/**
 * Which sessions have a turn running *in this process*, and how to stop one quickly.
 *
 * It used to be the whole of cancellation: a route started a turn, held its `AbortController` here
 * so a later request from another tab could find it, and cleared it when the turn settled. That is
 * no longer where a turn comes from — the queue is, and the worker that claimed a request owns the
 * controller for it. So this is now written to by the worker and read by exactly one thing: the
 * cancel route. It used to answer "is this session busy?" for the project routes and the reaper as
 * well, and that was wrong the moment turns moved to another process — the cluster-wide answer is
 * `TurnQueue.anyLeased`.
 *
 * **It is a fast path, not the mechanism.** The durable answer to "stop this turn" is
 * `cancel_requested` on the turn request, which any pod can set and the worker holding the lease
 * acts on within one renewal interval. This makes a cancel arriving at the pod that happens to be
 * running the turn instant instead, and does nothing at all when it arrives anywhere else. Both are
 * correct; one is nicer.
 *
 * **Releasing takes the controller it is releasing.** A turn that ends after the next one has begun
 * would otherwise clear the new turn's entry and silently disable its cancel button — the entry is
 * only removed if it is still the one that was adopted.
 */

import type { TurnState } from "./state-machine.ts";

export type ActiveTurn = {
  turnId: string;
  sessionId: string;
  userId: string;
  projectId?: string;
  state: TurnState;
  submitClarification?: (answers: string[]) => boolean;
};

export class TurnRegistry {
  readonly #running = new Map<string, AbortController>();
  readonly #activeTurns = new Map<string, ActiveTurn>();

  /**
   * Records that this process is running a turn on this session, and how to stop it.
   *
   * **It does not abort whatever was here before, and there is nothing to abort.** It used to,
   * defensively. This map is keyed by session, and two live entries for one session would need two
   * turns running on it at once — which `turn_requests_one_leased_per_session` makes impossible,
   * since a worker only adopts a controller for a request it holds the session's lease on, and the
   * fencing window means the previous holder aborted before anyone else could claim
   * (`docs/scaling-design.md` §5, §17 B-5). A guard nobody can trigger is worse than no guard: it
   * has never been observed working, so it is not known to work, and it tells the next reader that
   * a race exists which the schema has already made impossible.
   */
  adopt(sessionId: string, controller: AbortController): void {
    this.#running.set(sessionId, controller);
  }

  /** Whether the abort reached a turn. `false` means it is running elsewhere, or had ended. */
  cancel(sessionId: string): boolean {
    const controller = this.#running.get(sessionId);
    if (controller === undefined) return false;

    controller.abort();
    this.#running.delete(sessionId);
    return true;
  }

  /** Called when a turn settles, whichever way it settled. */
  release(sessionId: string, controller: AbortController): void {
    if (this.#running.get(sessionId) !== controller) return;
    this.#running.delete(sessionId);
  }

  /**
   * Registers an active turn for lifecycle state tracking and clarification coordination.
   */
  registerTurn(turn: ActiveTurn): void {
    this.#activeTurns.set(turn.turnId, turn);
  }

  /**
   * Looks up an active turn by its turnId.
   */
  getTurn(turnId: string): ActiveTurn | undefined {
    return this.#activeTurns.get(turnId);
  }

  /**
   * Updates the lifecycle state of an active turn.
   */
  updateTurnState(turnId: string, state: TurnState): void {
    const turn = this.#activeTurns.get(turnId);
    if (turn !== undefined) {
      turn.state = state;
    }
  }

  /**
   * Unregisters an active turn once it finishes or aborts.
   */
  unregisterTurn(turnId: string): void {
    this.#activeTurns.delete(turnId);
  }
}

import type { SceneState } from "./deterministic-builder.ts";
import { emptyScene } from "./deterministic-builder.ts";

export type CommitResult =
  | { status: "committed"; newRevision: number; candidateScene: SceneState }
  | { status: "stale_base"; currentRevision: number };

/**
 * Scene registry managing committed 3D scene state with optimistic concurrency.
 *
 * Each project has a monotonically increasing integer revision. When an atomic step
 * passes Gates 1, 2, and 3, `commitCandidate` verifies that the scene's revision
 * has not changed since planning began (`expectedWorkingRevision === currentRevision`).
 *
 * If a concurrent turn or edit incremented the revision, the commit returns
 * `{ status: "stale_base", currentRevision }`, triggering the turn state machine
 * to transition to `stale` and replan against the updated state.
 */
export class SceneRegistry {
  readonly #scenes = new Map<string, SceneState>();

  /**
   * Returns the current integer revision for a project's scene.
   * Defaults to 0 if no scene exists yet for the project.
   */
  getRevision(projectId: string): number {
    return this.#scenes.get(projectId)?.revision ?? 0;
  }

  /**
   * Returns the committed scene state for a project, initializing an empty
   * scene at revision 0 if none has been registered yet.
   */
  getScene(projectId: string): SceneState {
    const existing = this.#scenes.get(projectId);
    if (existing !== undefined) return existing;
    const initial = emptyScene(0);
    this.#scenes.set(projectId, initial);
    return initial;
  }

  /**
   * Attempts to commit an accepted candidate scene against the expected working revision.
   *
   * If `currentRevision !== expectedWorkingRevision`, the scene is NOT overwritten and
   * `{ status: "stale_base", currentRevision }` is returned.
   * Otherwise, increments the revision monotonically and persists the new scene state.
   */
  commitCandidate(
    projectId: string,
    expectedWorkingRevision: number,
    candidateScene: SceneState,
    _stepMetadata?: unknown,
  ): CommitResult {
    const current = this.getScene(projectId);
    if (current.revision !== expectedWorkingRevision) {
      return { status: "stale_base", currentRevision: current.revision };
    }

    const nextRevision = current.revision + 1;
    const committed: SceneState = {
      nodes: new Map(candidateScene.nodes),
      revision: nextRevision,
    };
    this.#scenes.set(projectId, committed);
    return { status: "committed", newRevision: nextRevision, candidateScene: committed };
  }

  /** Directly sets a scene state, used for testing or snapshot restoration. */
  setScene(projectId: string, scene: SceneState): void {
    this.#scenes.set(projectId, scene);
  }
}

/** Singleton scene registry instance for standard runtime use. */
export const globalSceneRegistry = new SceneRegistry();


