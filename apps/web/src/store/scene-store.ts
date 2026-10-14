"use client";

/**
 * Live-Editable 3D Scene Store with Undo/Redo & Optimistic Concurrency.
 *
 * Tracks the live scene graph, handles committed deltas from turns, enables
 * real-time user edits from the 3D Viewport and Property Inspector, manages
 * multi-step undo/redo history (up to 50 snapshots), and computes deterministic
 * world AABB bounds for spatial queries and collision checking.
 */

import { useSyncExternalStore } from "react";

export type Vec3 = [number, number, number];

export type AABB = {
  min: Vec3;
  max: Vec3;
};

export type BoxGeometrySpec = {
  kind: "box";
  width: number;
  height: number;
  depth: number;
  bevelRadius?: number;
};

export type CylinderGeometrySpec = {
  kind: "cylinder";
  radiusTop: number;
  radiusBottom: number;
  height: number;
  radialSegments?: number;
};

export type SphereGeometrySpec = {
  kind: "sphere";
  radius: number;
  widthSegments?: number;
};

export type ConeGeometrySpec = {
  kind: "cone";
  radius: number;
  height: number;
  radialSegments?: number;
};

export type TorusGeometrySpec = {
  kind: "torus";
  radius: number;
  tube: number;
  arc?: number;
};

export type CapsuleGeometrySpec = {
  kind: "capsule";
  radius: number;
  length: number;
};

export type GeometrySpec =
  | BoxGeometrySpec
  | CylinderGeometrySpec
  | SphereGeometrySpec
  | ConeGeometrySpec
  | TorusGeometrySpec
  | CapsuleGeometrySpec;

export type MaterialSpec = {
  color: string;
  roughness?: number | undefined;
  metalness?: number | undefined;
  opacity?: number | undefined;
  emissive?: string | undefined;
  emissiveIntensity?: number | undefined;
};

export type RelativeAnchor = {
  targetNodeId: string;
  relation:
    | "on_top_of"
    | "underneath"
    | "beside_left"
    | "beside_right"
    | "in_front_of"
    | "behind"
    | "centered_on";
  margin?: number;
  alignX?: "min" | "center" | "max";
  alignZ?: "min" | "center" | "max";
};

export type TransformSpec = {
  position: Vec3;
  rotationDeg: Vec3;
  scale: Vec3;
  anchor?: RelativeAnchor;
};

export type SceneNode = {
  nodeId: string;
  nodeType: "mesh" | "group";
  parentId: string | null;
  name: string;
  transform: TransformSpec;
  geometry?: GeometrySpec | undefined;
  material?: MaterialSpec | undefined;
  derivedWorldAABB?: AABB | undefined;
};

export type SceneSnapshot = {
  revision: number;
  nodes: Record<string, SceneNode>;
  selectedNodeId: string | null;
};

export type SceneStoreState = {
  projectId: string;
  revision: number;
  nodes: Record<string, SceneNode>;
  selectedNodeId: string | null;
  undoStack: SceneSnapshot[];
  redoStack: SceneSnapshot[];
};

export const MAX_HISTORY = 50;

/** Computes local AABB for geometry primitives centered at local origin. */
export function computeLocalAABB(geometry: GeometrySpec): AABB {
  switch (geometry.kind) {
    case "box": {
      const hw = geometry.width / 2;
      const hh = geometry.height / 2;
      const hd = geometry.depth / 2;
      return { min: [-hw, -hh, -hd], max: [hw, hh, hd] };
    }
    case "cylinder": {
      const maxR = Math.max(geometry.radiusTop, geometry.radiusBottom);
      const hh = geometry.height / 2;
      return { min: [-maxR, -hh, -maxR], max: [maxR, hh, maxR] };
    }
    case "sphere": {
      const r = geometry.radius;
      return { min: [-r, -r, -r], max: [r, r, r] };
    }
    case "cone": {
      const r = geometry.radius;
      const hh = geometry.height / 2;
      return { min: [-r, -hh, -r], max: [r, hh, r] };
    }
    case "torus": {
      const outerR = geometry.radius + geometry.tube;
      const t = geometry.tube;
      return { min: [-outerR, -t, -outerR], max: [outerR, t, outerR] };
    }
    case "capsule": {
      const r = geometry.radius;
      const totalH = geometry.length + 2 * r;
      const hh = totalH / 2;
      return { min: [-r, -hh, -r], max: [r, hh, r] };
    }
  }
}

/** Computes world-space position and AABB for all nodes hierarchically. */
export function recomputeWorldAABBs(
  nodes: Record<string, SceneNode>,
): Record<string, SceneNode> {
  const result: Record<string, SceneNode> = {};

  const computeWorldPos = (nodeId: string, visited = new Set<string>()): Vec3 => {
    if (visited.has(nodeId)) return [0, 0, 0];
    visited.add(nodeId);

    const node = nodes[nodeId];
    if (!node) return [0, 0, 0];

    const localPos = node.transform.position;
    if (!node.parentId || !nodes[node.parentId]) {
      return [...localPos];
    }

    const parentPos = computeWorldPos(node.parentId, visited);
    return [
      parentPos[0] + localPos[0],
      parentPos[1] + localPos[1],
      parentPos[2] + localPos[2],
    ];
  };

  for (const [id, node] of Object.entries(nodes)) {
    const worldPos = computeWorldPos(id);
    let derivedWorldAABB: AABB | undefined;

    if (node.geometry) {
      const local = computeLocalAABB(node.geometry);
      const sx = node.transform.scale[0];
      const sy = node.transform.scale[1];
      const sz = node.transform.scale[2];

      derivedWorldAABB = {
        min: [
          local.min[0] * sx + worldPos[0],
          local.min[1] * sy + worldPos[1],
          local.min[2] * sz + worldPos[2],
        ],
        max: [
          local.max[0] * sx + worldPos[0],
          local.max[1] * sy + worldPos[1],
          local.max[2] * sz + worldPos[2],
        ],
      };
    }

    result[id] = {
      ...node,
      derivedWorldAABB,
    };
  }

  return result;
}

export type SceneStore = {
  getState: () => SceneStoreState;
  subscribe: (listener: () => void) => () => void;
  getCommittedRevision: () => number;
  setSelectedNodeId: (nodeId: string | null) => void;
  updateNodeTransform: (nodeId: string, transform: Partial<TransformSpec>) => void;
  updateNodeGeometry: (nodeId: string, geometry: GeometrySpec) => void;
  updateNodeMaterial: (nodeId: string, material: Partial<MaterialSpec>) => void;
  deleteNode: (nodeId: string) => void;
  applyCommittedStepDelta: (sceneDelta: unknown, newRevision: number) => void;
  undo: () => void;
  redo: () => void;
  reset: (projectId: string, revision: number, nodes?: Record<string, SceneNode>) => void;
};

export function createSceneStore(
  initialProjectId = "default",
  initialRevision = 0,
  initialNodes: Record<string, SceneNode> = {},
): SceneStore {
  let state: SceneStoreState = {
    projectId: initialProjectId,
    revision: initialRevision,
    nodes: recomputeWorldAABBs(initialNodes),
    selectedNodeId: null,
    undoStack: [],
    redoStack: [],
  };

  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => l());

  const pushSnapshot = () => {
    const snapshot: SceneSnapshot = {
      revision: state.revision,
      nodes: { ...state.nodes },
      selectedNodeId: state.selectedNodeId,
    };
    const nextUndo = [...state.undoStack, snapshot];
    if (nextUndo.length > MAX_HISTORY) nextUndo.shift();

    state = {
      ...state,
      undoStack: nextUndo,
      redoStack: [], // clearing redo branch on mutation
    };
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getCommittedRevision: () => state.revision,

    setSelectedNodeId: (nodeId) => {
      if (state.selectedNodeId === nodeId) return;
      state = { ...state, selectedNodeId: nodeId };
      notify();
    },

    updateNodeTransform: (nodeId, partialTransform) => {
      const node = state.nodes[nodeId];
      if (!node) return;

      pushSnapshot();

      const updatedTransform: TransformSpec = {
        position: partialTransform.position ?? node.transform.position,
        rotationDeg: partialTransform.rotationDeg ?? node.transform.rotationDeg,
        scale: partialTransform.scale ?? node.transform.scale,
        ...(partialTransform.anchor !== undefined
          ? { anchor: partialTransform.anchor }
          : node.transform.anchor
            ? { anchor: node.transform.anchor }
            : {}),
      };

      const nextNodes = {
        ...state.nodes,
        [nodeId]: {
          ...node,
          transform: updatedTransform,
        },
      };

      state = {
        ...state,
        nodes: recomputeWorldAABBs(nextNodes),
      };
      notify();
    },

    updateNodeGeometry: (nodeId, geometry) => {
      const node = state.nodes[nodeId];
      if (!node) return;

      pushSnapshot();

      const nextNodes = {
        ...state.nodes,
        [nodeId]: {
          ...node,
          geometry,
        },
      };

      state = {
        ...state,
        nodes: recomputeWorldAABBs(nextNodes),
      };
      notify();
    },

    updateNodeMaterial: (nodeId, material) => {
      const node = state.nodes[nodeId];
      if (!node) return;

      pushSnapshot();

      const existingMaterial = node.material ?? { color: "#cccccc" };
      const updatedMaterial: MaterialSpec = {
        color: material.color ?? existingMaterial.color,
        roughness: material.roughness ?? existingMaterial.roughness,
        metalness: material.metalness ?? existingMaterial.metalness,
        opacity: material.opacity ?? existingMaterial.opacity,
        ...(material.emissive !== undefined
          ? { emissive: material.emissive }
          : existingMaterial.emissive !== undefined
            ? { emissive: existingMaterial.emissive }
            : {}),
        ...(material.emissiveIntensity !== undefined
          ? { emissiveIntensity: material.emissiveIntensity }
          : existingMaterial.emissiveIntensity !== undefined
            ? { emissiveIntensity: existingMaterial.emissiveIntensity }
            : {}),
      };

      const nextNodes: Record<string, SceneNode> = {
        ...state.nodes,
        [nodeId]: {
          ...node,
          material: updatedMaterial,
        },
      };

      state = {
        ...state,
        nodes: nextNodes,
      };
      notify();
    },

    deleteNode: (nodeId) => {
      if (!state.nodes[nodeId]) return;

      pushSnapshot();

      // Find all child descendants recursively
      const toDelete = new Set<string>([nodeId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const [id, n] of Object.entries(state.nodes)) {
          if (!toDelete.has(id) && n.parentId && toDelete.has(n.parentId)) {
            toDelete.add(id);
            changed = true;
          }
        }
      }

      const nextNodes: Record<string, SceneNode> = {};
      for (const [id, n] of Object.entries(state.nodes)) {
        if (!toDelete.has(id)) {
          nextNodes[id] = n;
        }
      }

      state = {
        ...state,
        nodes: recomputeWorldAABBs(nextNodes),
        selectedNodeId:
          state.selectedNodeId && toDelete.has(state.selectedNodeId)
            ? null
            : state.selectedNodeId,
      };
      notify();
    },

    applyCommittedStepDelta: (sceneDelta, newRevision) => {
      pushSnapshot();

      const nextNodes: Record<string, SceneNode> = { ...state.nodes };

      // Helper to process a single SceneOperation
      const applyOp = (op: Record<string, unknown>) => {
        const kind = op.op as string;
        const nodeId = op.nodeId as string;

        switch (kind) {
          case "create_node": {
            nextNodes[nodeId] = {
              nodeId,
              nodeType: (op.nodeType as "mesh" | "group") ?? "mesh",
              parentId: (op.parentId as string | null) ?? null,
              name: (op.name as string) ?? nodeId,
              transform: (op.transform as TransformSpec) ?? {
                position: [0, 0, 0],
                rotationDeg: [0, 0, 0],
                scale: [1, 1, 1],
              },
              ...(op.geometry ? { geometry: op.geometry as GeometrySpec } : {}),
              ...(op.material ? { material: op.material as MaterialSpec } : {}),
            };
            break;
          }
          case "update_transform": {
            const existing = nextNodes[nodeId];
            if (existing && op.transform) {
              nextNodes[nodeId] = {
                ...existing,
                transform: op.transform as TransformSpec,
              };
            }
            break;
          }
          case "update_geometry": {
            const existing = nextNodes[nodeId];
            if (existing && op.geometry) {
              nextNodes[nodeId] = {
                ...existing,
                geometry: op.geometry as GeometrySpec,
              };
            }
            break;
          }
          case "update_material": {
            const existing = nextNodes[nodeId];
            if (existing && op.material) {
              nextNodes[nodeId] = {
                ...existing,
                material: op.material as MaterialSpec,
              };
            }
            break;
          }
          case "reparent_node": {
            const existing = nextNodes[nodeId];
            if (existing) {
              nextNodes[nodeId] = {
                ...existing,
                parentId: (op.newParentId as string | null) ?? null,
              };
            }
            break;
          }
          case "delete_node": {
            delete nextNodes[nodeId];
            break;
          }
        }
      };

      // Support ProceduralStep ({ operations: [...] }) or array or direct nodes object
      if (
        sceneDelta &&
        typeof sceneDelta === "object" &&
        "operations" in sceneDelta &&
        Array.isArray((sceneDelta as { operations: unknown[] }).operations)
      ) {
        for (const op of (sceneDelta as { operations: Record<string, unknown>[] })
          .operations) {
          applyOp(op);
        }
      } else if (Array.isArray(sceneDelta)) {
        for (const op of sceneDelta as Record<string, unknown>[]) {
          applyOp(op);
        }
      } else if (
        sceneDelta &&
        typeof sceneDelta === "object" &&
        "nodes" in sceneDelta
      ) {
        const incomingNodes = (sceneDelta as { nodes: Record<string, SceneNode> })
          .nodes;
        for (const [id, n] of Object.entries(incomingNodes)) {
          nextNodes[id] = n;
        }
      }

      state = {
        ...state,
        revision: Math.max(state.revision, newRevision),
        nodes: recomputeWorldAABBs(nextNodes),
      };
      notify();
    },

    undo: () => {
      if (state.undoStack.length === 0) return;

      const previous = state.undoStack[state.undoStack.length - 1];
      if (!previous) return;

      const nextUndo = state.undoStack.slice(0, -1);
      const currentSnapshot: SceneSnapshot = {
        revision: state.revision,
        nodes: { ...state.nodes },
        selectedNodeId: state.selectedNodeId,
      };

      state = {
        ...state,
        revision: previous.revision,
        nodes: { ...previous.nodes },
        selectedNodeId: previous.selectedNodeId,
        undoStack: nextUndo,
        redoStack: [...state.redoStack, currentSnapshot],
      };
      notify();
    },

    redo: () => {
      if (state.redoStack.length === 0) return;

      const next = state.redoStack[state.redoStack.length - 1];
      if (!next) return;

      const nextRedo = state.redoStack.slice(0, -1);
      const currentSnapshot: SceneSnapshot = {
        revision: state.revision,
        nodes: { ...state.nodes },
        selectedNodeId: state.selectedNodeId,
      };

      state = {
        ...state,
        revision: next.revision,
        nodes: { ...next.nodes },
        selectedNodeId: next.selectedNodeId,
        undoStack: [...state.undoStack, currentSnapshot],
        redoStack: nextRedo,
      };
      notify();
    },

    reset: (projectId, revision, nodes = {}) => {
      state = {
        projectId,
        revision,
        nodes: recomputeWorldAABBs(nodes),
        selectedNodeId: null,
        undoStack: [],
        redoStack: [],
      };
      notify();
    },
  };
}

// Global default singleton store for convenient workbench usage
export const defaultSceneStore = createSceneStore();

export function useSceneStore(store: SceneStore = defaultSceneStore) {
  const state = useSyncExternalStore(store.subscribe, store.getState);

  return {
    ...state,
    setSelectedNodeId: store.setSelectedNodeId,
    updateNodeTransform: store.updateNodeTransform,
    updateNodeGeometry: store.updateNodeGeometry,
    updateNodeMaterial: store.updateNodeMaterial,
    deleteNode: store.deleteNode,
    applyCommittedStepDelta: store.applyCommittedStepDelta,
    undo: store.undo,
    redo: store.redo,
    getCommittedRevision: store.getCommittedRevision,
    reset: store.reset,
  };
}
