import { describe, expect, it } from "vitest";
import { migrateScene } from "./migrations.ts";
import { towerSpec } from "./tower.ts";

describe("migrateScene", () => {
  it("accepts a version-1 scene", () => {
    const result = migrateScene(towerSpec());
    expect(result.ok).toBe(true);
  });

  it("rejects a future version instead of guessing", () => {
    const result = migrateScene({ ...towerSpec(), version: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unsupported_version");
  });

  it("rejects input with no version", () => {
    const { version: _omitted, ...rest } = towerSpec();
    const result = migrateScene(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("missing_version");
  });

  it("rejects non-objects", () => {
    expect(migrateScene(null).ok).toBe(false);
    expect(migrateScene("scene").ok).toBe(false);
  });

  it("rejects a version-1 scene that fails validation", () => {
    expect(migrateScene({ ...towerSpec(), root: "missing" }).ok).toBe(false);
  });
});
