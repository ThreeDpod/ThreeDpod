import { describe, expect, it } from "vitest";
import { SceneRegistry, TurnRegistry } from "./registry.ts";
import { emptyScene } from "./deterministic-builder.ts";

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const OTHER = "1c8e9a2f-4d3b-4e6c-8f7a-2b3c4d5e6f70";
const PROJECT_A = "proj-123";
const PROJECT_B = "proj-456";

describe("TurnRegistry", () => {
  it("aborts the adopted turn's controller on a matching cancel", () => {
    const registry = new TurnRegistry();
    const controller = new AbortController();
    registry.adopt(SESSION, controller);

    expect(registry.cancel(SESSION)).toBe(true);
    expect(controller.signal.aborted).toBe(true);
  });

  it("reports that there was nothing to cancel here", () => {
    // Either the turn ended as the user clicked, or it is running on another pod. Both are races
    // rather than failures, and the durable `cancel_requested` has already reached the second.
    const registry = new TurnRegistry();

    expect(registry.cancel(SESSION)).toBe(false);
  });

  it("forgets a turn once it is released", () => {
    // Without this, cancelling after a turn ends aborts a controller nobody is holding, and the
    // *next* turn on the session inherits an already-aborted signal.
    const registry = new TurnRegistry();
    const controller = new AbortController();
    registry.adopt(SESSION, controller);

    registry.release(SESSION, controller);

    expect(registry.cancel(SESSION)).toBe(false);
  });

  it("does not let a later turn's completion cancel the one running now", () => {
    // A slow turn that settles after the next has begun would otherwise clear the entry the new
    // turn depends on, silently disabling its cancel button.
    const registry = new TurnRegistry();
    const first = new AbortController();
    const second = new AbortController();
    registry.adopt(SESSION, first);
    registry.adopt(SESSION, second);

    registry.release(SESSION, first);

    expect(registry.cancel(SESSION)).toBe(true);
    expect(second.signal.aborted).toBe(true);
  });

  it("takes the later turn on a session without touching the earlier one", () => {
    // The replaced controller used to be aborted here, defensively. It is not any more, and this
    // asserts the absence rather than leaving it untested: with one leased request per session in
    // the whole cluster and a fencing window that makes the previous holder abort before anyone
    // else can claim, two live entries for one session is unreachable — and a branch nobody can
    // reach has never been observed working. See `docs/scaling-design.md` §17 (B-5).
    const registry = new TurnRegistry();
    const first = new AbortController();
    registry.adopt(SESSION, first);

    const second = new AbortController();
    registry.adopt(SESSION, second);

    expect(first.signal.aborted).toBe(false);
    expect(registry.cancel(SESSION)).toBe(true);
    expect(second.signal.aborted).toBe(true);
  });

  it("keeps sessions apart", () => {
    const registry = new TurnRegistry();
    const mine = new AbortController();
    registry.adopt(SESSION, mine);
    registry.adopt(OTHER, new AbortController());

    registry.cancel(OTHER);

    expect(mine.signal.aborted).toBe(false);
  });

  it("registers, updates, looks up, and unregisters active turns", () => {
    const registry = new TurnRegistry();
    const turnId = "turn-001";
    let clarifiedWith: string[] = [];

    registry.registerTurn({
      turnId,
      sessionId: SESSION,
      userId: "user-123",
      state: "needs_input",
      submitClarification: (answers) => {
        clarifiedWith = answers;
        return true;
      },
    });

    const turn = registry.getTurn(turnId);
    expect(turn).toBeDefined();
    expect(turn?.state).toBe("needs_input");

    turn?.submitClarification?.(["answer1", "answer2"]);
    expect(clarifiedWith).toEqual(["answer1", "answer2"]);

    registry.updateTurnState(turnId, "planning_scene");
    expect(registry.getTurn(turnId)?.state).toBe("planning_scene");

    registry.unregisterTurn(turnId);
    expect(registry.getTurn(turnId)).toBeUndefined();
  });
});

describe("SceneRegistry", () => {
  it("defaults revision to 0 for unknown project", () => {
    const registry = new SceneRegistry();
    expect(registry.getRevision(PROJECT_A)).toBe(0);
    const scene = registry.getScene(PROJECT_A);
    expect(scene.revision).toBe(0);
    expect(scene.nodes.size).toBe(0);
  });

  it("commits candidate when working revision matches current revision", () => {
    const registry = new SceneRegistry();
    const initialRev = registry.getRevision(PROJECT_A); // 0
    const candidate = emptyScene(initialRev);

    const result = registry.commitCandidate(PROJECT_A, initialRev, candidate);
    expect(result.status).toBe("committed");
    if (result.status === "committed") {
      expect(result.newRevision).toBe(1);
      expect(registry.getRevision(PROJECT_A)).toBe(1);
      expect(registry.getScene(PROJECT_A).revision).toBe(1);
    }
  });

  it("rejects commit with stale_base when revision has diverged", () => {
    const registry = new SceneRegistry();
    const initialRev = registry.getRevision(PROJECT_A); // 0

    // Another turn commits first, advancing revision to 1
    const firstCandidate = emptyScene(initialRev);
    const firstResult = registry.commitCandidate(PROJECT_A, initialRev, firstCandidate);
    expect(firstResult.status).toBe("committed");

    // Second turn tries to commit against original base revision 0
    const secondCandidate = emptyScene(initialRev);
    const secondResult = registry.commitCandidate(PROJECT_A, initialRev, secondCandidate);

    expect(secondResult.status).toBe("stale_base");
    if (secondResult.status === "stale_base") {
      expect(secondResult.currentRevision).toBe(1);
    }
    // Scene revision remains 1
    expect(registry.getRevision(PROJECT_A)).toBe(1);
  });

  it("isolates revisions across different projects", () => {
    const registry = new SceneRegistry();
    registry.commitCandidate(PROJECT_A, 0, emptyScene(0));

    expect(registry.getRevision(PROJECT_A)).toBe(1);
    expect(registry.getRevision(PROJECT_B)).toBe(0);
  });
});

