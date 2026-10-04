import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileObjectStore } from "./file-object-store.ts";

describe("FileObjectStore", () => {
  let dir = "";
  let store: FileObjectStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nap-objects-"));
    store = new FileObjectStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips bytes under nested keys", async () => {
    const bytes = new TextEncoder().encode("a git bundle, more or less");
    expect((await store.put("projects/abc/snap.bundle", bytes)).ok).toBe(true);
    const read = await store.get("projects/abc/snap.bundle");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value).toEqual(bytes);
  });

  it("replaces whatever was at the key", async () => {
    await store.put("k", new Uint8Array([1]));
    await store.put("k", new Uint8Array([2]));
    const read = await store.get("k");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value).toEqual(new Uint8Array([2]));
  });

  it("answers not_found for a missing key", async () => {
    const read = await store.get("projects/abc/missing.bundle");
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.code).toBe("not_found");
  });

  it("deletes, and deleting a missing key succeeds", async () => {
    await store.put("k", new Uint8Array([1]));
    expect((await store.delete("k")).ok).toBe(true);
    const read = await store.get("k");
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.code).toBe("not_found");
    expect((await store.delete("never-there")).ok).toBe(true);
  });

  it("refuses keys that escape the base directory", async () => {
    // A key naming a file outside the store is a caller bug the store must not
    // honor. Each of these would resolve outside `dir` without the guard.
    for (const key of ["../escape", "a/../../escape", "/absolute", "", "a//b"]) {
      expect((await store.put(key, new Uint8Array([1]))).ok, key).toBe(false);
      expect((await store.get(key)).ok, key).toBe(false);
      expect((await store.delete(key)).ok, key).toBe(false);
    }
  });

  it("resolves the base directory absolutely", () => {
    expect(isAbsolute(store.baseDir())).toBe(true);
  });
});
