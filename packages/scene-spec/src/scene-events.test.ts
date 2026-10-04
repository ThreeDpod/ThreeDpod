import { describe, expect, it } from "vitest";
import { collectSceneChain, foldSceneSpec } from "./fold.ts";
import { hashSceneSpec } from "./revisions.ts";
import { readSceneHead, sceneLogEvents } from "./scene-events.ts";
import { towerSpec } from "./tower.ts";

const TURN = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

function updated(spec: unknown, parentHash: string | null, specHash: string) {
  return {
    sessionId: "session-1",
    turnId: TURN,
    seq: 1,
    createdAt: "2026-08-09T12:00:00.000Z",
    type: "scene.updated",
    payload: { spec, parentHash, specHash },
  } as const;
}

/** Fold-input shape: what sceneLogEvents produces from stored events. */
function foldUpdated(spec: unknown, parentHash: string | null, specHash: string, turnId = TURN) {
  return { type: "scene.updated", spec, parentHash, specHash, turnId } as const;
}

describe("sceneLogEvents", () => {
  it("narrows stored events to the fold input, dropping everything else", () => {
    const spec = towerSpec();
    const events = [
      {
        sessionId: "session-1",
        turnId: TURN,
        seq: 1,
        createdAt: "2026-08-09T12:00:00.000Z",
        type: "user.message",
        payload: { text: "make it wider" },
      },
      updated(spec, null, hashSceneSpec(spec)),
    ] as const;

    const narrowed = sceneLogEvents(events);
    expect(narrowed).toHaveLength(1);
    expect(narrowed[0]).toMatchObject({ type: "scene.updated", turnId: TURN });
  });
});

describe("readSceneHead", () => {
  it("folds stored events to the authoritative head", () => {
    const spec = towerSpec();
    const head = readSceneHead([updated(spec, null, hashSceneSpec(spec))]);

    expect(head?.hash).toBe(hashSceneSpec(spec));
    expect(head?.spec).toEqual(spec);
  });

  it("returns null when no valid scene update exists", () => {
    expect(readSceneHead([])).toBe(null);
  });
});

describe("collectSceneChain", () => {
  it("returns accepted entries in order with head last", () => {
    const genesis = towerSpec();
    const genesisHash = hashSceneSpec(genesis);
    const events = [foldUpdated(genesis, null, genesisHash)];

    const chain = collectSceneChain(events);
    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatchObject({ hash: genesisHash, parentHash: null, turnId: TURN });

    // Same ordered input folds to the same head: the chain and the head agree.
    expect(foldSceneSpec(events)?.hash).toBe(chain.at(-1)?.hash);
  });

  it("omits skipped entries so materialization never sees them", () => {
    const genesis = towerSpec();
    const events = [
      foldUpdated(genesis, null, genesisHashOf(genesis)),
      foldUpdated({ version: 999 }, genesisHashOf(genesis), "f".repeat(64)),
    ];

    expect(collectSceneChain(events)).toHaveLength(1);
  });
});

function genesisHashOf(spec: ReturnType<typeof towerSpec>): string {
  return hashSceneSpec(spec);
}
