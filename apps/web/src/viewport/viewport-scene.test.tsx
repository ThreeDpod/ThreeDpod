/**
 * Viewport scene assembly tests: real Three.js math, no GPU.
 *
 * `createViewportScene` never creates a renderer — that is the component's job —
 * so these tests run the actual scene graph construction (adapter meshes, lights,
 * camera framing, selection) in jsdom with a plain canvas element.
 */

import { buildScene } from "@nap/procedural/build";
import { towerSpec } from "@nap/scene-spec/tower";
import type * as THREE from "three";
import { describe, expect, it } from "vitest";
import { applySelection, createViewportScene, disposeViewportScene } from "./viewport-scene.ts";

function towerBuilt() {
  const built = buildScene(towerSpec());
  if (!built.ok) throw new Error(`fixture failed to build: ${built.error.message}`);
  return built.value;
}

describe("createViewportScene", () => {
  it("assembles three meshes under one group", () => {
    const viewport = createViewportScene(towerBuilt(), document.createElement("canvas"));
    try {
      expect(viewport.group.children).toHaveLength(3);
      expect(viewport.scene.children).toContain(viewport.group);
    } finally {
      disposeViewportScene(viewport);
    }
  });

  it("frames the tower in the camera", () => {
    const viewport = createViewportScene(towerBuilt(), document.createElement("canvas"));
    try {
      // The camera stands off from the tower center along a fixed diagonal.
      expect(viewport.camera.position.length()).toBeGreaterThan(4);
      const direction = viewport.camera.position.clone().normalize();
      expect(direction.x).toBeGreaterThan(0);
      expect(direction.y).toBeGreaterThan(0);
      expect(direction.z).toBeGreaterThan(0);
    } finally {
      disposeViewportScene(viewport);
    }
  });

  it("highlights the selected node and restores on deselect", () => {
    const viewport = createViewportScene(towerBuilt(), document.createElement("canvas"));
    try {
      applySelection(viewport.group, "base");
      const base = viewport.group.children.find(
        (child) => (child as THREE.Mesh).userData.nodeId === "base",
      ) as THREE.Mesh;
      const mid = viewport.group.children.find(
        (child) => (child as THREE.Mesh).userData.nodeId === "mid",
      ) as THREE.Mesh;
      expect((base.material as THREE.MeshStandardMaterial).emissiveIntensity).toBeGreaterThan(0);
      expect((mid.material as THREE.MeshStandardMaterial).emissiveIntensity).toBe(0);

      applySelection(viewport.group, null);
      expect((base.material as THREE.MeshStandardMaterial).emissiveIntensity).toBe(0);
    } finally {
      disposeViewportScene(viewport);
    }
  });

  it("disposal fires dispose on every geometry and material", () => {
    const viewport = createViewportScene(towerBuilt(), document.createElement("canvas"));
    let disposed = 0;
    viewport.scene.traverse((child) => {
      const mesh = child as THREE.Mesh;
      (mesh.geometry as THREE.BufferGeometry | undefined)?.addEventListener("dispose", () => {
        disposed += 1;
      });
      const material = mesh.material as THREE.Material | undefined;
      material?.addEventListener("dispose", () => {
        disposed += 1;
      });
    });
    disposeViewportScene(viewport);
    // 3 geometries + 3 mesh materials. Lights/grid/axes materials are covered
    // too, so this is a lower bound, not an exact count.
    expect(disposed).toBeGreaterThanOrEqual(6);
  });
});
