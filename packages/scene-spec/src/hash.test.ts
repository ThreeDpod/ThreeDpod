import { describe, expect, it } from "vitest";
import { canonicalize } from "./canonical.ts";
import { sha256Hex, utf8Bytes } from "./hash.ts";
import { hashSceneSpec } from "./revisions.ts";
import { towerSpec } from "./tower.ts";

describe("sha256Hex", () => {
  it('matches the NIST vector for "abc"', () => {
    expect(sha256Hex(utf8Bytes("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches the NIST vector for the empty string", () => {
    expect(sha256Hex(utf8Bytes(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("hashSceneSpec", () => {
  it("is stable for equivalent specs", () => {
    expect(hashSceneSpec(towerSpec())).toBe(hashSceneSpec(structuredClone(towerSpec())));
  });

  it("changes when any semantic field changes", () => {
    const base = hashSceneSpec(towerSpec());
    const wider = structuredClone(towerSpec());
    const mid = wider.nodes.find((node) => node.id === "mid");
    if (mid?.kind !== "procedural" || mid.op !== "box") throw new Error("fixture changed shape");
    mid.params.width = 1.5;
    expect(hashSceneSpec(wider)).not.toBe(base);
  });

  it("pins the tower golden hash", () => {
    // Computed by this implementation and verified stable across repeated runs;
    // any canonicalization change must update this value deliberately.
    expect(hashSceneSpec(towerSpec())).toBe(TOWER_GOLDEN_HASH);
    expect(canonicalize(towerSpec()).length).toBe(TOWER_GOLDEN_LENGTH);
  });
});

// Pinned values from this implementation, verified stable across repeated runs;
// any canonicalization change must update these deliberately.
const TOWER_GOLDEN_HASH = "b3534b9a9a9f507cb5c610dac20bdc27d0eb3db5f302eb4776b86c64b48f65b8";
const TOWER_GOLDEN_LENGTH = 997;
