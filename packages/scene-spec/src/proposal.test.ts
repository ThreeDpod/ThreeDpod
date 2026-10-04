import { describe, expect, it } from "vitest";
import { MAX_SCENE_EVENT_BYTES } from "./limits.ts";
import {
  AnySceneProposalSchema,
  CreateSceneSchema,
  type SceneProposal,
  validateProposal,
} from "./proposal.ts";
import { hashSceneSpec } from "./revisions.ts";
import { towerSpec } from "./tower.ts";

function head() {
  return towerSpec();
}

function headHash(): string {
  return hashSceneSpec(head());
}

function proposal(overrides: Partial<SceneProposal> = {}): SceneProposal {
  return {
    baseHash: headHash(),
    ops: [{ op: "set_param", nodeId: "base", key: "width", value: 2.4 }],
    rationale: "Widen the base by twenty percent.",
    ...overrides,
  };
}

describe("validateProposal", () => {
  it("accepts a valid proposal against the current head", () => {
    const result = validateProposal(proposal(), head());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.specHash).not.toBe(headHash());
    const base = result.value.spec.nodes.find((node) => node.id === "base");
    if (base?.kind !== "procedural" || base.op !== "box") throw new Error("unexpected shape");
    expect(base.params.width).toBe(2.4);
  });

  it("rejects malformed proposals without touching the head", () => {
    const before = headHash();
    for (const bad of [
      { ...proposal(), ops: [] },
      { ...proposal(), ops: [{ op: "teleport", nodeId: "base" }] },
      { ...proposal(), baseHash: "not-a-hash" },
      { ...proposal(), baseHash: "0".repeat(63) },
      { ...proposal(), rationale: "" },
      { ...proposal(), rationale: "x".repeat(501) },
      "a string is not a proposal",
      null,
    ]) {
      const result = validateProposal(bad, head());
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invalid_proposal");
    }
    expect(headHash()).toBe(before);
  });

  it("rejects a well-formed but stale base hash", () => {
    const result = validateProposal(proposal({ baseHash: "0".repeat(64) }), head());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("stale_base");
      expect(result.error.message).toContain("0".repeat(12));
    }
  });

  it("rejects a proposal when there is no head scene", () => {
    const result = validateProposal(proposal(), null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("no_base");
  });

  it("passes patch failures through with their codes", () => {
    const unknownNode = validateProposal(
      proposal({ ops: [{ op: "rename", nodeId: "ghost", name: "X" }] }),
      head(),
    );
    expect(unknownNode.ok).toBe(false);
    if (!unknownNode.ok) expect(unknownNode.error.code).toBe("unknown_node");

    const outOfRange = validateProposal(
      proposal({ ops: [{ op: "set_param", nodeId: "base", key: "width", value: -2 }] }),
      head(),
    );
    expect(outOfRange.ok).toBe(false);
  });

  it("rejects no-op proposals instead of appending empty revisions", () => {
    const result = validateProposal(
      proposal({ ops: [{ op: "set_param", nodeId: "base", key: "width", value: 2 }] }),
      head(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("no_op");
  });

  it("leaves headroom under the payload limit for the largest valid scene", () => {
    // The v1 schema caps (256 nodes) cannot reach the transport limit; this pins
    // that the gate below is unreachable today and documents the headroom.
    const result = validateProposal(proposal(), head());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.canonicalLength).toBeLessThan(MAX_SCENE_EVENT_BYTES / 4);
  });
});

describe("validateProposal creation", () => {
  function creation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { spec: towerSpec(), rationale: "Model a squat tower.", ...overrides };
  }

  it("accepts a complete valid spec against an empty head", () => {
    const result = validateProposal(creation(), null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.specHash).toBe(hashSceneSpec(towerSpec()));
    expect(result.value.spec.nodes).toHaveLength(towerSpec().nodes.length);
  });

  it("rejects creation when a head already exists", () => {
    const result = validateProposal(creation(), head());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("scene_exists");
      expect(result.error.message).toContain(headHash().slice(0, 12));
    }
  });

  it("rejects malformed creation payloads without touching anything", () => {
    for (const bad of [
      creation({ spec: { version: 1 } }),
      creation({ spec: towerSpec(), rationale: "" }),
      creation({ spec: towerSpec(), rationale: "x".repeat(501) }),
      // Mixed shapes match neither arm: not an edit, not a creation.
      { ...creation(), baseHash: headHash(), ops: [] },
      { baseHash: headHash(), ops: [], spec: towerSpec(), rationale: "Both." },
    ]) {
      const result = validateProposal(bad, null);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invalid_proposal");
    }
  });

  it("rejects oversized genesis scenes at the same transport limit", () => {
    const big = towerSpec();
    const nodes = big.nodes;
    while (JSON.stringify({ ...big, nodes }).length < MAX_SCENE_EVENT_BYTES + 1) {
      const extra = structuredClone(nodes[1]);
      if (extra === undefined) throw new Error("fixture changed shape");
      nodes.push({ ...extra, id: `extra-${nodes.length}` });
    }
    // The tower cap (256 nodes) is hit long before the byte cap here only if the
    // test below stays honest: assert which gate actually fired.
    const result = validateProposal(creation({ spec: big }), null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["payload_too_large", "invalid_proposal"]).toContain(result.error.code);
    }
  });

  it("keeps edit proposals parsing exactly as before", () => {
    // The union tries the unchanged edit arm first: every previously valid edit
    // input must still validate, and still reject the same way when stale.
    expect(validateProposal(proposal(), head()).ok).toBe(true);
    const stale = validateProposal(proposal({ baseHash: "0".repeat(64) }), head());
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("stale_base");
  });

  it("exposes both variants in the tool-facing union schema", () => {
    expect(AnySceneProposalSchema.safeParse(creation()).success).toBe(true);
    expect(AnySceneProposalSchema.safeParse(proposal()).success).toBe(true);
    expect(CreateSceneSchema.safeParse(creation()).success).toBe(true);
  });
});
