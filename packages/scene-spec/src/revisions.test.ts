import { describe, expect, it } from "vitest";
import { applyPatch, type ScenePatch } from "./patch.ts";
import {
  createChildRevision,
  createGenesisRevision,
  hashSceneSpec,
  RevisionLog,
} from "./revisions.ts";
import { TOWER_BASE_ID, towerSpec } from "./tower.ts";

const AUTHOR = { kind: "user" as const, label: "test" };

describe("revisions", () => {
  it("creates a genesis revision with a stable hash", () => {
    const first = createGenesisRevision({ sceneId: "s1", spec: towerSpec(), author: AUTHOR });
    const second = createGenesisRevision({ sceneId: "s1", spec: towerSpec(), author: AUTHOR });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.parentId).toBe(null);
    // Same content, same hash — ids and timestamps may differ.
    expect(first.value.specHash).toBe(second.value.specHash);
  });

  it("rejects an invalid genesis spec", () => {
    const result = createGenesisRevision({ sceneId: "s1", spec: { version: 1 }, author: AUTHOR });
    expect(result.ok).toBe(false);
  });

  it("links children to parents and undo restores the exact hash", () => {
    const genesis = createGenesisRevision({ sceneId: "s1", spec: towerSpec(), author: AUTHOR });
    if (!genesis.ok) throw new Error("fixture invalid");
    const log = RevisionLog.begin(genesis.value);
    const originalHash = log.head().specHash;

    const edited = applyPatch(
      log.head().spec,
      {
        baseRevision: originalHash,
        ops: [{ op: "set_param", nodeId: TOWER_BASE_ID, key: "width", value: 2.4 }],
      } satisfies ScenePatch,
      originalHash,
    );
    if (!edited.ok) throw new Error("patch failed");
    const child = createChildRevision({
      sceneId: "s1",
      parent: log.head(),
      spec: edited.value,
      author: AUTHOR,
    });
    if (!child.ok) throw new Error("child failed");
    log.append(child.value);

    expect(log.head().parentId).toBe(genesis.value.id);
    expect(log.head().specHash).not.toBe(originalHash);

    const undone = log.undo();
    expect(undone).not.toBe(null);
    expect(log.head().specHash).toBe(originalHash);
    expect(log.head().spec).toEqual(genesis.value.spec);
  });

  it("undo at genesis returns null and keeps the head", () => {
    const genesis = createGenesisRevision({ sceneId: "s1", spec: towerSpec(), author: AUTHOR });
    if (!genesis.ok) throw new Error("fixture invalid");
    const log = RevisionLog.begin(genesis.value);
    expect(log.undo()).toBe(null);
    expect(log.head().id).toBe(genesis.value.id);
  });

  it("redo follows the recorded child after an undo", () => {
    const genesis = createGenesisRevision({ sceneId: "s1", spec: towerSpec(), author: AUTHOR });
    if (!genesis.ok) throw new Error("fixture invalid");
    const log = RevisionLog.begin(genesis.value);
    const edited = applyPatch(
      log.head().spec,
      {
        baseRevision: log.head().specHash,
        ops: [{ op: "rename", nodeId: TOWER_BASE_ID, name: "Wide base" }],
      } satisfies ScenePatch,
      log.head().specHash,
    );
    if (!edited.ok) throw new Error("patch failed");
    const child = createChildRevision({
      sceneId: "s1",
      parent: log.head(),
      spec: edited.value,
      author: AUTHOR,
    });
    if (!child.ok) throw new Error("child failed");
    log.append(child.value);
    log.undo();
    const redone = log.redo();
    expect(redone?.id).toBe(child.value.id);
  });

  it("reports redo availability honestly", () => {
    const genesis = createGenesisRevision({ sceneId: "s1", spec: towerSpec(), author: AUTHOR });
    if (!genesis.ok) throw new Error("fixture invalid");
    const log = RevisionLog.begin(genesis.value);
    expect(log.canRedo()).toBe(false);
    const edited = applyPatch(
      log.head().spec,
      {
        baseRevision: log.head().specHash,
        ops: [{ op: "rename", nodeId: TOWER_BASE_ID, name: "Wide base" }],
      } satisfies ScenePatch,
      log.head().specHash,
    );
    if (!edited.ok) throw new Error("patch failed");
    const child = createChildRevision({
      sceneId: "s1",
      parent: log.head(),
      spec: edited.value,
      author: AUTHOR,
    });
    if (!child.ok) throw new Error("child failed");
    log.append(child.value);
    expect(log.canRedo()).toBe(false);
    log.undo();
    expect(log.canRedo()).toBe(true);
  });

  it("refuses to append a revision parented elsewhere", () => {
    const genesis = createGenesisRevision({ sceneId: "s1", spec: towerSpec(), author: AUTHOR });
    if (!genesis.ok) throw new Error("fixture invalid");
    const log = RevisionLog.begin(genesis.value);
    const foreign = createGenesisRevision({ sceneId: "s1", spec: towerSpec(), author: AUTHOR });
    if (!foreign.ok) throw new Error("fixture invalid");
    expect(() => log.append(foreign.value)).toThrow();
  });

  it("detects a corrupted parent instead of forking history", () => {
    const genesis = createGenesisRevision({ sceneId: "s1", spec: towerSpec(), author: AUTHOR });
    if (!genesis.ok) throw new Error("fixture invalid");
    const corrupted = { ...genesis.value, specHash: "0".repeat(64) };
    const result = createChildRevision({
      sceneId: "s1",
      parent: corrupted,
      spec: towerSpec(),
      author: AUTHOR,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("parent_mismatch");
  });

  it("reapplying the same edit from genesis reproduces the child hash", () => {
    const makeEdited = () => {
      const genesis = createGenesisRevision({ sceneId: "s1", spec: towerSpec(), author: AUTHOR });
      if (!genesis.ok) throw new Error("fixture invalid");
      const edited = applyPatch(
        genesis.value.spec,
        {
          baseRevision: genesis.value.specHash,
          ops: [{ op: "set_param", nodeId: TOWER_BASE_ID, key: "width", value: 2.4 }],
        } satisfies ScenePatch,
        genesis.value.specHash,
      );
      if (!edited.ok) throw new Error("patch failed");
      return hashSceneSpec(edited.value);
    };
    expect(makeEdited()).toBe(makeEdited());
  });

  it("redo on a branch follows the first-inserted child", () => {
    // Undo then editing again shelves the first child without deleting it: the log holds a
    // branch, and redo walks insertion order, so the older sibling wins. Pinned rather than
    // fixed — whether the product should offer branch choice is an open question.
    const genesis = createGenesisRevision({ sceneId: "s1", spec: towerSpec(), author: AUTHOR });
    if (!genesis.ok) throw new Error("fixture invalid");
    const log = RevisionLog.begin(genesis.value);
    const childOf = (name: string) => {
      const edited = applyPatch(
        log.head().spec,
        {
          baseRevision: log.head().specHash,
          ops: [{ op: "rename", nodeId: TOWER_BASE_ID, name }],
        } satisfies ScenePatch,
        log.head().specHash,
      );
      if (!edited.ok) throw new Error("patch failed");
      const child = createChildRevision({
        sceneId: "s1",
        parent: log.head(),
        spec: edited.value,
        author: AUTHOR,
      });
      if (!child.ok) throw new Error("child failed");
      return child.value;
    };

    const first = childOf("First edit");
    log.append(first);
    log.undo();
    const second = childOf("Second edit");
    log.append(second);
    log.undo();

    expect(log.canRedo()).toBe(true);
    expect(log.redo()?.id).toBe(first.id);
    // The lineage shown is the one redo chose; the shelved sibling stays stored but unlisted.
    expect(log.history().map((revision) => revision.id)).toEqual([genesis.value.id, first.id]);
  });
});
