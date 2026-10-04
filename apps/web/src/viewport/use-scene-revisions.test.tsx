import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { installViewportTestShims } from "./test-shims.ts";
import { useSceneRevisions } from "./use-scene-revisions.ts";

installViewportTestShims();

describe("useSceneRevisions", () => {
  it("starts from the tower fixture with a pinned hash", () => {
    const { result } = renderHook(() => useSceneRevisions());
    expect(result.current.history).toHaveLength(1);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.selectedId).toBe("base");
    expect(result.current.head.specHash).toBe(
      "b3534b9a9a9f507cb5c610dac20bdc27d0eb3db5f302eb4776b86c64b48f65b8",
    );
    expect(result.current.built?.triangleCount).toBe(36);
    expect(result.current.buildError).toBe(null);
  });

  it("creates a parent-linked revision on width edit", () => {
    const { result } = renderHook(() => useSceneRevisions());
    const before = result.current.head;
    act(() => result.current.setWidth("base", 2.4));
    expect(result.current.history).toHaveLength(2);
    expect(result.current.head.parentId).toBe(before.id);
    expect(result.current.head.specHash).not.toBe(before.specHash);
    expect(result.current.editError).toBe(null);
    expect(result.current.built?.bounds.min[0]).toBeCloseTo(-1.2, 10);
    expect(result.current.built?.bounds.max[0]).toBeCloseTo(1.2, 10);
  });

  it("rejects invalid widths without creating a revision", () => {
    const { result } = renderHook(() => useSceneRevisions());
    const before = result.current.head.id;
    act(() => result.current.setWidth("base", Number.NaN));
    expect(result.current.editError).not.toBe(null);
    expect(result.current.head.id).toBe(before);
    expect(result.current.history).toHaveLength(1);
    act(() => result.current.setWidth("base", -5));
    expect(result.current.history).toHaveLength(1);
  });

  it("rejects widths outside the dimensional limits", () => {
    const { result } = renderHook(() => useSceneRevisions());
    act(() => result.current.setWidth("base", 500));
    expect(result.current.editError).not.toBe(null);
    expect(result.current.history).toHaveLength(1);
  });

  it("ignores edits that change nothing: no revision on identical width", () => {
    const { result } = renderHook(() => useSceneRevisions());
    // Focusing the field and tabbing away, or Enter followed by blur, commits
    // the value already there — the log must not grow.
    act(() => result.current.setWidth("base", 2));
    act(() => result.current.setWidth("base", 2));
    expect(result.current.history).toHaveLength(1);
    expect(result.current.editError).toBe(null);
  });

  it("undo restores the exact previous hash and redo returns", () => {
    const { result } = renderHook(() => useSceneRevisions());
    const original = result.current.head.specHash;
    act(() => result.current.setWidth("base", 2.4));
    expect(result.current.head.specHash).not.toBe(original);
    act(() => result.current.undo());
    expect(result.current.head.specHash).toBe(original);
    expect(result.current.history).toHaveLength(1);
    expect(result.current.canRedo).toBe(true);
    act(() => result.current.redo());
    expect(result.current.head.specHash).not.toBe(original);
    expect(result.current.history).toHaveLength(2);
  });

  it("exports and validates the built scene", async () => {
    const { result } = renderHook(() => useSceneRevisions());
    await act(async () => {
      await result.current.exportAndValidate();
    });
    const status = result.current.exportStatus;
    expect(status.state).toBe("ready");
    if (status.state !== "ready") return;
    expect(status.meshCount).toBe(3);
    expect(status.byteLength).toBeGreaterThan(0);
    expect(status.current).toBe(true);
  });

  it("marks the export stale after a newer edit lands", async () => {
    const { result } = renderHook(() => useSceneRevisions());
    await act(async () => {
      await result.current.exportAndValidate();
    });
    act(() => result.current.setWidth("base", 2.4));
    // A newer edit resets export state — the pane never shows bytes for the
    // wrong revision as if they were current.
    expect(result.current.exportStatus.state).toBe("idle");
  });
});
