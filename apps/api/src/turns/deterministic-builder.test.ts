import { describe, expect, it } from "vitest";
import {
  emptyScene,
  localAABBForGeometry,
  resolveAnchor,
  runDeterministicBuilder,
  sceneFromNodes,
  transformAABB,
  type SceneNode,
} from "./deterministic-builder.ts";
import type { ProceduralStep } from "./schemas.ts";

describe("localAABBForGeometry", () => {
  it("computes bounds for box", () => {
    const aabb = localAABBForGeometry({ kind: "box", width: 2, height: 1, depth: 4, bevelRadius: 0 });
    expect(aabb.min).toEqual([-1, -0.5, -2]);
    expect(aabb.max).toEqual([1, 0.5, 2]);
  });

  it("computes bounds for cylinder", () => {
    const aabb = localAABBForGeometry({
      kind: "cylinder",
      radiusTop: 0.5,
      radiusBottom: 1.0,
      height: 2,
      radialSegments: 32,
    });
    expect(aabb.min).toEqual([-1, -1, -1]);
    expect(aabb.max).toEqual([1, 1, 1]);
  });

  it("computes bounds for sphere", () => {
    const aabb = localAABBForGeometry({ kind: "sphere", radius: 1.5, widthSegments: 32 });
    expect(aabb.min).toEqual([-1.5, -1.5, -1.5]);
    expect(aabb.max).toEqual([1.5, 1.5, 1.5]);
  });

  it("computes bounds for cone", () => {
    const aabb = localAABBForGeometry({ kind: "cone", radius: 0.8, height: 2, radialSegments: 32 });
    expect(aabb.min).toEqual([-0.8, -1, -0.8]);
    expect(aabb.max).toEqual([0.8, 1, 0.8]);
  });

  it("computes bounds for torus", () => {
    const aabb = localAABBForGeometry({ kind: "torus", radius: 2, tube: 0.5, arc: Math.PI * 2 });
    expect(aabb.min).toEqual([-2.5, -0.5, -2.5]);
    expect(aabb.max).toEqual([2.5, 0.5, 2.5]);
  });

  it("computes bounds for capsule", () => {
    const aabb = localAABBForGeometry({ kind: "capsule", radius: 0.3, length: 1.0 });
    expect(aabb.min).toEqual([-0.3, -0.8, -0.3]);
    expect(aabb.max).toEqual([0.3, 0.8, 0.3]);
  });
});

describe("transformAABB", () => {
  it("offsets and scales AABB", () => {
    const initial = { min: [-1, -1, -1] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
    const transformed = transformAABB(initial, {
      position: [10, 5, -2],
      rotationDeg: [0, 0, 0],
      scale: [2, 3, 1],
    });
    expect(transformed.min).toEqual([8, 2, -3]);
    expect(transformed.max).toEqual([12, 8, -1]);
  });
});

describe("resolveAnchor", () => {
  const targetAABB = {
    min: [-1, 0, -0.5] as [number, number, number],
    max: [1, 0.8, 0.5] as [number, number, number],
  };
  const candidateLocal = {
    min: [-0.2, -0.1, -0.2] as [number, number, number],
    max: [0.2, 0.1, 0.2] as [number, number, number],
  };

  it("resolves on_top_of", () => {
    const pos = resolveAnchor(
      { targetNodeId: "target", relation: "on_top_of", margin: 0.05, alignX: "center", alignZ: "center" },
      targetAABB,
      candidateLocal,
    );
    expect(pos[0]).toBe(0);
    // target max Y (0.8) + candidate half height (0.1) + margin (0.05) = 0.95
    expect(pos[1]).toBeCloseTo(0.95);
    expect(pos[2]).toBe(0);
  });

  it("resolves underneath", () => {
    const pos = resolveAnchor(
      { targetNodeId: "target", relation: "underneath", margin: 0.1, alignX: "center", alignZ: "center" },
      targetAABB,
      candidateLocal,
    );
    expect(pos[0]).toBe(0);
    // target min Y (0) - candidate half height (0.1) - margin (0.1) = -0.2
    expect(pos[1]).toBeCloseTo(-0.2);
    expect(pos[2]).toBe(0);
  });

  it("resolves beside_left with min alignment on Z", () => {
    const pos = resolveAnchor(
      { targetNodeId: "target", relation: "beside_left", margin: 0.05, alignX: "center", alignZ: "min" },
      targetAABB,
      candidateLocal,
    );
    // target min X (-1) - candidate half width (0.2) - margin (0.05) = -1.25
    expect(pos[0]).toBeCloseTo(-1.25);
    expect(pos[1]).toBe(0.4);
    // target min Z (-0.5) + candidate half depth (0.2) = -0.3
    expect(pos[2]).toBeCloseTo(-0.3);
  });
});

describe("runDeterministicBuilder", () => {
  it("fails Gate 1 if JSON cannot be parsed", () => {
    const scene = emptyScene();
    const result = runDeterministicBuilder(scene, "Not valid JSON at all!");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gate).toBe(1);
      expect(result.diagnostics).toContain("Gate 1");
    }
  });

  it("cleans markdown fences and <think> blocks before Gate 1", () => {
    const scene = emptyScene();
    const raw = `<think>planning desk</think>
\`\`\`json
{
  "stepId": "step_1",
  "intentSummary": "Create desk group",
  "operations": [
    {
      "op": "create_node",
      "nodeId": "desk_group",
      "label": "Desk Group",
      "nodeType": "group",
      "transform": { "position": [0, 0, 0], "rotationDeg": [0, 0, 0], "scale": [1, 1, 1] }
    }
  ],
  "assertions": []
}
\`\`\``;
    const result = runDeterministicBuilder(scene, raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidateScene.nodes.has("desk_group")).toBe(true);
    }
  });

  it("fails Gate 2a if schema validation fails", () => {
    const scene = emptyScene();
    const badJson = {
      stepId: "step_1",
      // missing intentSummary and operations
    };
    const result = runDeterministicBuilder(scene, badJson);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gate).toBe(2);
      expect(result.diagnostics).toContain("Gate 2a");
    }
  });

  it("fails Gate 2b if duplicate nodeId is created", () => {
    const existingNode: SceneNode = {
      nodeId: "desk_group",
      label: "Existing Desk",
      nodeType: "group",
      parentId: null,
      children: [],
      transform: { position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: [1, 1, 1] },
      localAABB: { min: [0, 0, 0], max: [0, 0, 0] },
      worldAABB: { min: [0, 0, 0], max: [0, 0, 0] },
    };
    const scene = sceneFromNodes([existingNode]);

    const step: ProceduralStep = {
      stepId: "step_2",
      intentSummary: "Duplicate node",
      operations: [
        {
          op: "create_node",
          nodeId: "desk_group",
          label: "Duplicate Desk",
          nodeType: "group",
          parentId: null,
          transform: { position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: [1, 1, 1] },
        },
      ],
      assertions: [],
    };

    const result = runDeterministicBuilder(scene, step);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gate).toBe(2);
      expect(result.diagnostics).toContain("already exists");
    }
  });

  it("fails Gate 2b if parentId does not exist", () => {
    const scene = emptyScene();
    const step: ProceduralStep = {
      stepId: "step_1",
      intentSummary: "Orphan node",
      operations: [
        {
          op: "create_node",
          nodeId: "desk_top",
          label: "Desk Top",
          nodeType: "mesh",
          parentId: "non_existent_group",
          transform: { position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: [1, 1, 1] },
          geometry: { kind: "box", width: 1.2, height: 0.05, depth: 0.6, bevelRadius: 0 },
          material: { color: "#8b5a2b", roughness: 0.6, metalness: 0, opacity: 1 },
        },
      ],
      assertions: [],
    };

    const result = runDeterministicBuilder(scene, step);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gate).toBe(2);
      expect(result.diagnostics).toContain("parentId 'non_existent_group' does not exist");
    }
  });

  it("fails Gate 2b if reparent_node creates a cycle", () => {
    const nodeA: SceneNode = {
      nodeId: "node_a",
      label: "Node A",
      nodeType: "group",
      parentId: null,
      children: ["node_b"],
      transform: { position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: [1, 1, 1] },
      localAABB: { min: [0, 0, 0], max: [0, 0, 0] },
      worldAABB: { min: [0, 0, 0], max: [0, 0, 0] },
    };
    const nodeB: SceneNode = {
      nodeId: "node_b",
      label: "Node B",
      nodeType: "group",
      parentId: "node_a",
      children: [],
      transform: { position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: [1, 1, 1] },
      localAABB: { min: [0, 0, 0], max: [0, 0, 0] },
      worldAABB: { min: [0, 0, 0], max: [0, 0, 0] },
    };
    const scene = sceneFromNodes([nodeA, nodeB]);

    const step: ProceduralStep = {
      stepId: "step_cycle",
      intentSummary: "Create cycle",
      operations: [
        {
          op: "reparent_node",
          nodeId: "node_a",
          newParentId: "node_b",
        },
      ],
      assertions: [],
    };

    const result = runDeterministicBuilder(scene, step);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gate).toBe(2);
      expect(result.diagnostics).toContain("cycle");
    }
  });

  it("fails Gate 2c if spatial assertion no_overlap fails and returns penetration diagnostics", () => {
    const scene = emptyScene();
    const step: ProceduralStep = {
      stepId: "step_overlap",
      intentSummary: "Overlapping boxes",
      operations: [
        {
          op: "create_node",
          nodeId: "box_1",
          label: "Box 1",
          nodeType: "mesh",
          parentId: null,
          transform: { position: [0, 0.5, 0], rotationDeg: [0, 0, 0], scale: [1, 1, 1] },
          geometry: { kind: "box", width: 1, height: 1, depth: 1, bevelRadius: 0 },
          material: { color: "#ffffff", roughness: 0.5, metalness: 0, opacity: 1 },
        },
        {
          op: "create_node",
          nodeId: "box_2",
          label: "Box 2",
          nodeType: "mesh",
          parentId: null,
          transform: { position: [0.5, 0.5, 0], rotationDeg: [0, 0, 0], scale: [1, 1, 1] },
          geometry: { kind: "box", width: 1, height: 1, depth: 1, bevelRadius: 0 },
          material: { color: "#ff0000", roughness: 0.5, metalness: 0, opacity: 1 },
        },
      ],
      assertions: [
        {
          check: "no_overlap",
          nodeA: "box_1",
          nodeB: "box_2",
          toleranceMeters: 0.005,
        },
      ],
    };

    const result = runDeterministicBuilder(scene, step);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.gate).toBe(2);
      expect(result.diagnostics).toContain("overlaps 'box_2'");
      expect(result.diagnostics).toContain("shift");
    }
  });

  it("never mutates committed scene on failure", () => {
    const scene = emptyScene();
    const badStep: ProceduralStep = {
      stepId: "bad_step",
      intentSummary: "Fail referential integrity",
      operations: [
        {
          op: "create_node",
          nodeId: "good_node",
          label: "Good Node",
          nodeType: "group",
          parentId: null,
          transform: { position: [0, 0, 0], rotationDeg: [0, 0, 0], scale: [1, 1, 1] },
        },
        {
          op: "delete_node",
          nodeId: "non_existent_node",
        },
      ],
      assertions: [],
    };

    const result = runDeterministicBuilder(scene, badStep);
    expect(result.ok).toBe(false);
    // committed scene should still be completely empty
    expect(scene.nodes.size).toBe(0);
  });

  it("resolves relative anchors and builds a valid candidate scene", () => {
    const scene = emptyScene();
    const step: ProceduralStep = {
      stepId: "step_build_table",
      intentSummary: "Build tabletop and lamp",
      operations: [
        {
          op: "create_node",
          nodeId: "table_top",
          label: "Table Top",
          nodeType: "mesh",
          parentId: null,
          transform: { position: [0, 0.75, 0], rotationDeg: [0, 0, 0], scale: [1, 1, 1] },
          geometry: { kind: "box", width: 1.4, height: 0.06, depth: 0.8, bevelRadius: 0 },
          material: { color: "#8b5a2b", roughness: 0.4, metalness: 0, opacity: 1 },
        },
        {
          op: "create_node",
          nodeId: "lamp_base",
          label: "Lamp Base",
          nodeType: "mesh",
          parentId: null,
          transform: {
            position: [0, 0, 0],
            rotationDeg: [0, 0, 0],
            scale: [1, 1, 1],
            anchor: {
              targetNodeId: "table_top",
              relation: "on_top_of",
              margin: 0,
              alignX: "center",
              alignZ: "center",
            },
          },
          geometry: { kind: "cylinder", radiusTop: 0.1, radiusBottom: 0.1, height: 0.02, radialSegments: 32 },
          material: { color: "#111111", roughness: 0.2, metalness: 0.8, opacity: 1 },
        },
      ],
      assertions: [
        {
          check: "resting_on",
          upperNodeId: "lamp_base",
          lowerNodeId: "table_top",
        },
      ],
    };

    const result = runDeterministicBuilder(scene, step);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.gate).toBe("all_passed");
      const lamp = result.candidateScene.nodes.get("lamp_base")!;
      // table_top max Y = 0.75 + 0.03 = 0.78
      // lamp half height = 0.01
      // lamp center Y should be 0.78 + 0.01 = 0.79
      expect(lamp.transform.position[1]).toBeCloseTo(0.79);
    }
  });
});
