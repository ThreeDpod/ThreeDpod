import { describe, expect, it } from "vitest";
import { CanonicalError, canonicalize } from "./canonical.ts";
import { towerSpec } from "./tower.ts";

describe("canonicalize", () => {
  it("orders keys regardless of construction order", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    expect(canonicalize({ outer: { z: [3], a: true }, m: null })).toBe(
      canonicalize({ m: null, outer: { a: true, z: [3] } }),
    );
  });

  it("keeps array order significant", () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it("serializes the tower deterministically across repeated calls", () => {
    const first = canonicalize(towerSpec());
    const second = canonicalize(structuredClone(towerSpec()));
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThan(100);
  });

  it("rejects non-finite numbers instead of hashing them as null", () => {
    // JSON.stringify(NaN) is "null" — accepting that would hash NaN and null alike.
    // This test fails if the rejection is ever removed.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      try {
        canonicalize({ width: bad });
        expect.unreachable("non-finite numbers must throw");
      } catch (error) {
        expect(error).toBeInstanceOf(CanonicalError);
        expect((error as CanonicalError).code).toBe("non_finite_number");
      }
    }
  });

  it("rejects undefined values instead of dropping them", () => {
    try {
      canonicalize({ width: undefined });
      expect.unreachable("undefined values must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CanonicalError);
      expect((error as CanonicalError).code).toBe("undefined_value");
    }
  });

  it("rejects unsupported types", () => {
    expect(() => canonicalize({ callback: () => {} })).toThrow(CanonicalError);
    expect(() => canonicalize(BigInt(3))).toThrow(CanonicalError);
  });
});
