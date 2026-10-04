import { describe, expect, it } from "vitest";
import { foldSceneSpec, type SceneLogEvent } from "./fold.ts";
import { applyPatch } from "./patch.ts";
import { hashSceneSpec } from "./revisions.ts";
import { towerSpec } from "./tower.ts";

function updated(
  spec: ReturnType<typeof towerSpec>,
  parentHash: string | null,
  turnId: string,
): Extract<SceneLogEvent, { type: "scene.updated" }> {
  return {
    type: "scene.updated",
    spec: structuredClone(spec),
    parentHash,
    specHash: hashSceneSpec(spec),
    turnId,
  };
}

function widened(): ReturnType<typeof towerSpec> {
  const spec = towerSpec();
  const baseHash = hashSceneSpec(spec);
  const patched = applyPatch(
    spec,
    {
      baseRevision: baseHash,
      ops: [{ op: "set_param", nodeId: "base", key: "width", value: 2.4 }],
    },
    baseHash,
  );
  if (!patched.ok) throw new Error("fixture patch failed");
  return patched.value;
}

describe("foldSceneSpec", () => {
  it("folds an empty log to no head", () => {
    expect(foldSceneSpec([])).toBe(null);
  });

  it("starts a chain from a genesis update", () => {
    const spec = towerSpec();
    const head = foldSceneSpec([updated(spec, null, "turn-1")]);
    expect(head?.hash).toBe(hashSceneSpec(spec));
    expect(head?.spec).toEqual(spec);
  });

  it("follows parent links to the latest revision", () => {
    const genesis = towerSpec();
    const child = widened();
    const head = foldSceneSpec([
      updated(genesis, null, "turn-1"),
      updated(child, hashSceneSpec(genesis), "turn-2"),
    ]);
    expect(head?.hash).toBe(hashSceneSpec(child));
  });

  it("is idempotent over duplicate deliveries", () => {
    const spec = towerSpec();
    const event = updated(spec, null, "turn-1");
    const once = foldSceneSpec([event]);
    const twice = foldSceneSpec([event, { ...event }]);
    expect(twice).toEqual(once);
  });

  it("resolves conflicting branches by order: later wins, deterministically", () => {    const genesis = towerSpec();
    const genesisHash = hashSceneSpec(genesis);
    const wide = widened();
    const renamed = applyPatch(
      genesis,
      { baseRevision: genesisHash, ops: [{ op: "rename", nodeId: "base", name: "Wide base" }] },
      genesisHash,
    );
    if (!renamed.ok) throw new Error("fixture patch failed");
    const first = foldSceneSpec([
      updated(genesis, null, "turn-1"),
      updated(wide, genesisHash, "turn-2"),
      updated(renamed.value, genesisHash, "turn-3"),
    ]);
    const second = foldSceneSpec([
      updated(genesis, null, "turn-1"),
      updated(wide, genesisHash, "turn-2"),
      updated(renamed.value, genesisHash, "turn-3"),
    ]);
    // Same ordered input, same output — and the later branch is the head.
    expect(first).toEqual(second);
    expect(first?.hash).toBe(hashSceneSpec(renamed.value));
  });

  it("skips updates whose parent is unknown, keeping the head", () => {
    const spec = towerSpec();
    const head = foldSceneSpec([
      updated(spec, null, "turn-1"),
      updated(widened(), "f".repeat(64), "turn-2"),
    ]);
    expect(head?.hash).toBe(hashSceneSpec(spec));
  });

  it("skips a second genesis with different content: first sequence wins", () => {
    // Two valid null-parent updates, different specs: the chain already
    // started, so the later one is a fork, not a restart. Both rows persist;
    // only the first becomes head. This is what makes concurrent creation
    // safe without new locking: determinism by sequence order.
    const other = widened();
    const otherHash = hashSceneSpec(other);
    expect(otherHash).not.toBe(hashSceneSpec(towerSpec()));
    const head = foldSceneSpec([
      updated(towerSpec(), null, "turn-1"),
      updated(other, null, "turn-2"),
    ]);
    expect(head?.hash).toBe(hashSceneSpec(towerSpec()));
  });

  it("skips updates whose hash does not match their spec", () => {
    const spec = towerSpec();
    const tampered = updated(widened(), hashSceneSpec(spec), "turn-2");
    tampered.specHash = "e".repeat(64);
    const head = foldSceneSpec([updated(spec, null, "turn-1"), tampered]);
    expect(head?.hash).toBe(hashSceneSpec(spec));
  });

  it("skips updates whose spec fails validation", () => {
    const spec = towerSpec();
    const broken = structuredClone(widened()) as unknown as Record<string, unknown>;
    delete broken.root;
    const head = foldSceneSpec([
      updated(spec, null, "turn-1"),
      {
        type: "scene.updated",
        spec: broken,
        parentHash: hashSceneSpec(spec),
        specHash: "d".repeat(64),
        turnId: "turn-2",
      },
    ]);
    expect(head?.hash).toBe(hashSceneSpec(spec));
  });

  it("ignores rejections: they carry diagnostics, not state", () => {
    const spec = towerSpec();
    const head = foldSceneSpec([
      updated(spec, null, "turn-1"),
      { type: "scene.rejected", diagnostics: "unknown node", turnId: "turn-2" },
    ]);
    expect(head?.hash).toBe(hashSceneSpec(spec));
  });

  it("reverts to a known hash without deleting history", () => {
    const genesis = towerSpec();
    const genesisHash = hashSceneSpec(genesis);
    const child = widened();
    const childHash = hashSceneSpec(child);
    const events: SceneLogEvent[] = [
      updated(genesis, null, "turn-1"),
      updated(child, genesisHash, "turn-2"),
      { type: "scene.reverted", toHash: genesisHash, turnId: "turn-3" },
    ];
    const head = foldSceneSpec(events);
    expect(head?.hash).toBe(genesisHash);
    expect(head?.spec).toEqual(genesis);
    // History is preserved: a later update can still build on the child.
    const continued = foldSceneSpec([...events, updated(child, childHash, "turn-4")]);
    expect(continued?.hash).toBe(childHash);
  });

  it("skips reverts to unknown hashes", () => {
    const spec = towerSpec();
    const head = foldSceneSpec([
      updated(spec, null, "turn-1"),
      { type: "scene.reverted", toHash: "a".repeat(64), turnId: "turn-2" },
    ]);
    expect(head?.hash).toBe(hashSceneSpec(spec));
  });

  it("is pure: same ordered input always folds identically", () => {
    const genesis = towerSpec();
    const events: SceneLogEvent[] = [
      updated(genesis, null, "turn-1"),
      updated(widened(), hashSceneSpec(genesis), "turn-2"),
      { type: "scene.reverted", toHash: hashSceneSpec(genesis), turnId: "turn-3" },
    ];
    expect(foldSceneSpec(events)).toEqual(foldSceneSpec(structuredClone(events)));
  });
});
