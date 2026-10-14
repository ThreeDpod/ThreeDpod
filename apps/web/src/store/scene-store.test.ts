import { describe, expect, it } from "vitest";
import {
  computeLocalAABB,
  createSceneStore,
  type GeometrySpec,
  type SceneNode,
} from "./scene-store.ts";

describe("scene-store", () => {
  describe("computeLocalAABB", () => {
    it("computes bounds for box", () => {
      const aabb = computeLocalAABB({
        kind: "box",
        width: 2,
        height: 1,
        depth: 0.5,
      });
      expect(aabb.min).toEqual([-1, -0.5, -0.25]);
      expect(aabb.max).toEqual([1, 0.5, 0.25]);
    });

    it("computes bounds for cylinder", () => {
      const aabb = computeLocalAABB({
        kind: "cylinder",
        radiusTop: 0.5,
        radiusBottom: 1.0,
        height: 2.0,
      });
      expect(aabb.min).toEqual([-1.0, -1.0, -1.0]);
      expect(aabb.max).toEqual([1.0, 1.0, 1.0]);
    });

    it("computes bounds for sphere", () => {
      const aabb = computeLocalAABB({ kind: "sphere", radius: 1.5 });
      expect(aabb.min).toEqual([-1.5, -1.5, -1.5]);
      expect(aabb.max).toEqual([1.5, 1.5, 1.5]);
    });

    it("computes bounds for cone", () => {
      const aabb = computeLocalAABB({ kind: "cone", radius: 0.8, height: 1.6 });
      expect(aabb.min).toEqual([-0.8, -0.8, -0.8]);
      expect(aabb.max).toEqual([0.8, 0.8, 0.8]);
    });

    it("computes bounds for torus", () => {
      const aabb = computeLocalAABB({ kind: "torus", radius: 2.0, tube: 0.4 });
      expect(aabb.min).toEqual([-2.4, -0.4, -2.4]);
      expect(aabb.max).toEqual([2.4, 0.4, 2.4]);
    });

    it("computes bounds for capsule", () => {
      const aabb = computeLocalAABB({ kind: "capsule", radius: 0.5, length: 2.0 });
      // Total height = 2 + 2*0.5 = 3
      expect(aabb.min).toEqual([-0.5, -1.5, -0.5]);
      expect(aabb.max).toEqual([0.5, 1.5, 0.5]);
    });
  });

  describe("store mutations and undo/redo", () => {
    const initialBoxNode: SceneNode = {
      nodeId: "table_top",
      name: "Table Top",
      nodeType: "mesh",
      parentId: null,
      transform: {
        position: [0, 0.75, 0],
        rotationDeg: [0, 0, 0],
        scale: [1, 1, 1],
      },
      geometry: { kind: "box", width: 1.6, height: 0.05, depth: 0.8 },
      material: { color: "#8b5a2b", roughness: 0.4, metalness: 0.1 },
    };

    it("initializes with computed world AABBs", () => {
      const store = createSceneStore("proj-1", 1, { table_top: initialBoxNode });
      const state = store.getState();
      expect(state.revision).toBe(1);
      expect(state.nodes.table_top?.derivedWorldAABB).toEqual({
        min: [-0.8, 0.75 - 0.025, -0.4],
        max: [0.8, 0.75 + 0.025, 0.4],
      });
    });

    it("updates transform and pushes undo snapshot", () => {
      const store = createSceneStore("proj-1", 1, { table_top: initialBoxNode });

      store.updateNodeTransform("table_top", { position: [0, 1.0, 0] });
      const state = store.getState();
      expect(state.nodes.table_top?.transform.position).toEqual([0, 1.0, 0]);
      expect(state.nodes.table_top?.derivedWorldAABB?.min[1]).toBeCloseTo(0.975);
      expect(state.undoStack).toHaveLength(1);

      // Undo restores original position
      store.undo();
      expect(store.getState().nodes.table_top?.transform.position).toEqual([
        0, 0.75, 0,
      ]);
      expect(store.getState().redoStack).toHaveLength(1);

      // Redo re-applies the new position
      store.redo();
      expect(store.getState().nodes.table_top?.transform.position).toEqual([
        0, 1.0, 0,
      ]);
    });

    it("updates geometry and material", () => {
      const store = createSceneStore("proj-1", 1, { table_top: initialBoxNode });

      const newGeom: GeometrySpec = {
        kind: "box",
        width: 2.0,
        height: 0.1,
        depth: 1.0,
      };
      store.updateNodeGeometry("table_top", newGeom);
      expect(store.getState().nodes.table_top?.geometry).toEqual(newGeom);

      store.updateNodeMaterial("table_top", { color: "#000000", metalness: 0.8 });
      expect(store.getState().nodes.table_top?.material?.color).toBe("#000000");
      expect(store.getState().nodes.table_top?.material?.metalness).toBe(0.8);
      expect(store.getState().nodes.table_top?.material?.roughness).toBe(0.4);
    });

    it("deletes node and cascades to children", () => {
      const parentGroup: SceneNode = {
        nodeId: "desk_group",
        name: "Desk",
        nodeType: "group",
        parentId: null,
        transform: { position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: [1, 1, 1] },
      };
      const childMesh: SceneNode = {
        nodeId: "desk_leg",
        name: "Leg",
        nodeType: "mesh",
        parentId: "desk_group",
        transform: { position: [0.5, 0.35, 0.5], rotationDeg: [0, 0, 0], scale: [1, 1, 1] },
        geometry: { kind: "cylinder", radiusTop: 0.03, radiusBottom: 0.03, height: 0.7 },
      };

      const store = createSceneStore("proj-1", 1, {
        desk_group: parentGroup,
        desk_leg: childMesh,
      });

      store.setSelectedNodeId("desk_leg");
      store.deleteNode("desk_group");

      const state = store.getState();
      expect(state.nodes.desk_group).toBeUndefined();
      expect(state.nodes.desk_leg).toBeUndefined();
      expect(state.selectedNodeId).toBeNull();
    });

    it("applies committed step delta from procedural step", () => {
      const store = createSceneStore("proj-1", 1);

      const proceduralDelta = {
        stepId: "step_0",
        intentSummary: "Build desk frame",
        operations: [
          {
            op: "create_node",
            nodeId: "desk_frame",
            nodeType: "mesh",
            parentId: null,
            name: "Desk Frame",
            transform: { position: [0, 0.35, 0], rotationDeg: [0, 0, 0], scale: [1, 1, 1] },
            geometry: { kind: "box", width: 1.5, height: 0.7, depth: 0.8 },
            material: { color: "#222222" },
          },
        ],
      };

      store.applyCommittedStepDelta(proceduralDelta, 2);

      const state = store.getState();
      expect(state.revision).toBe(2);
      expect(state.nodes.desk_frame).toBeDefined();
      expect(state.nodes.desk_frame?.geometry?.kind).toBe("box");
      expect(store.getCommittedRevision()).toBe(2);
    });
  });
});
