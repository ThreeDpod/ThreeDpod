/**
 * Deterministic builder: Gates 1 and 2 of the turn pipeline.
 *
 * This module is the pure, deterministic core of the pipeline. Given a committed
 * scene state and raw model output, it:
 *
 *   1. **Gate 1** — Parses the raw output as JSON using `extractCleanJson`.
 *   2. **Gate 2a** — Validates the parsed JSON against `ProceduralStepSchema`.
 *   3. **Gate 2b** — Checks referential integrity of every operation against the
 *      committed scene state (unique IDs, existing parents, no cycles, mesh
 *      nodes have geometry/material).
 *   4. **Gate 2c** — Computes world-space AABBs, resolves anchors deterministically,
 *      and evaluates spatial constraint assertions (no_overlap, grounded_on_floor,
 *      resting_on).
 *
 * **A bad step never mutates the committed scene.** The candidate is built on a
 * `structuredClone` of the committed state, so a failed gate leaves the original
 * untouched and can be retried with different model output.
 *
 * This module is deliberately free of any I/O, model calls, or side effects.
 * It is a function of `(committedScene, rawOutput) → GateResult`, making it
 * straightforward to unit test with literal inputs.
 */

import { z } from "zod";
import { extractCleanJson } from "./model-access.ts";
import {
  ProceduralStepSchema,
  type GeometrySpec,
  type MaterialSpec,
  type ProceduralStep,
  type RelativeAnchor,
  type SceneOperation,
  type SpatialConstraintAssertion,
  type TransformSpec,
  type Vec3,
} from "./schemas.ts";

// ── Types ────────────────────────────────────────────────────────────────────

/** An axis-aligned bounding box in world space. */
export type AABB = {
  min: [number, number, number];
  max: [number, number, number];
};

/** A node in the scene graph, as tracked by the deterministic builder. */
export type SceneNode = {
  nodeId: string;
  label: string;
  nodeType: "group" | "mesh";
  parentId: string | null;
  children: string[];
  transform: TransformSpec;
  geometry?: GeometrySpec | undefined;
  material?: MaterialSpec | undefined;
  /** Local-space AABB computed from geometry. */
  localAABB: AABB;
  /** World-space AABB after applying ancestor transforms. */
  worldAABB: AABB;
};

/** The scene state the builder works with. */
export type SceneState = {
  nodes: Map<string, SceneNode>;
  revision: number;
};

export type GateResult =
  | { ok: true; gate: "all_passed"; candidateScene: SceneState; step: ProceduralStep }
  | { ok: false; gate: 1; diagnostics: string }
  | { ok: false; gate: 2; diagnostics: string };

// ── AABB computation ─────────────────────────────────────────────────────────

/** Computes the local AABB for a geometry primitive centered at origin. */
export function localAABBForGeometry(geometry: GeometrySpec): AABB {
  switch (geometry.kind) {
    case "box": {
      const hw = geometry.width / 2;
      const hh = geometry.height / 2;
      const hd = geometry.depth / 2;
      return { min: [-hw, -hh, -hd], max: [hw, hh, hd] };
    }
    case "cylinder": {
      const maxRadius = Math.max(geometry.radiusTop, geometry.radiusBottom);
      const hh = geometry.height / 2;
      return { min: [-maxRadius, -hh, -maxRadius], max: [maxRadius, hh, maxRadius] };
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
      const outer = geometry.radius + geometry.tube;
      return { min: [-outer, -geometry.tube, -outer], max: [outer, geometry.tube, outer] };
    }
    case "capsule": {
      const r = geometry.radius;
      const totalH = geometry.length / 2 + r;
      return { min: [-r, -totalH, -r], max: [r, totalH, r] };
    }
  }
}

/** An empty AABB for group nodes with no geometry of their own. */
const EMPTY_AABB: AABB = { min: [0, 0, 0], max: [0, 0, 0] };

/**
 * Applies a position and scale transform to an AABB.
 *
 * Rotation is intentionally approximated as axis-aligned — a full OBB would be
 * more precise but the pipeline only uses rotation for orientation (90°/180°
 * increments), and the AABB is used for overlap detection where a slight
 * over-estimate is safer than an under-estimate.
 */
export function transformAABB(aabb: AABB, transform: TransformSpec): AABB {
  const [px, py, pz] = transform.position ?? [0, 0, 0];
  const [sx, sy, sz] = transform.scale ?? [1, 1, 1];

  return {
    min: [
      aabb.min[0] * Math.abs(sx) + px,
      aabb.min[1] * Math.abs(sy) + py,
      aabb.min[2] * Math.abs(sz) + pz,
    ],
    max: [
      aabb.max[0] * Math.abs(sx) + px,
      aabb.max[1] * Math.abs(sy) + py,
      aabb.max[2] * Math.abs(sz) + pz,
    ],
  };
}

/**
 * Computes the world-space AABB for a node by walking up the parent chain
 * and accumulating transforms.
 */
export function computeWorldAABB(nodeId: string, nodes: Map<string, SceneNode>): AABB {
  const node = nodes.get(nodeId);
  if (node === undefined) return EMPTY_AABB;

  // Start with the local AABB
  let aabb = node.localAABB;

  // Walk up the parent chain, accumulating transforms
  let current: SceneNode | undefined = node;
  while (current !== undefined) {
    aabb = transformAABB(aabb, current.transform);
    current = current.parentId !== null ? nodes.get(current.parentId) : undefined;
  }

  return aabb;
}

/**
 * Expands a group node's AABB to encompass all its children's world AABBs.
 */
function expandGroupAABB(nodeId: string, nodes: Map<string, SceneNode>): AABB {
  const node = nodes.get(nodeId);
  if (node === undefined) return EMPTY_AABB;
  if (node.children.length === 0) return node.worldAABB;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const childId of node.children) {
    const child = nodes.get(childId);
    if (child === undefined) continue;
    const childAABB = child.nodeType === "group" ? expandGroupAABB(childId, nodes) : child.worldAABB;
    minX = Math.min(minX, childAABB.min[0]);
    minY = Math.min(minY, childAABB.min[1]);
    minZ = Math.min(minZ, childAABB.min[2]);
    maxX = Math.max(maxX, childAABB.max[0]);
    maxY = Math.max(maxY, childAABB.max[1]);
    maxZ = Math.max(maxZ, childAABB.max[2]);
  }

  if (!isFinite(minX)) return EMPTY_AABB;
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

// ── Anchor resolution ────────────────────────────────────────────────────────

/**
 * Resolves a relative anchor to a concrete position offset.
 *
 * Given the target node's world AABB and the candidate node's local AABB,
 * computes the position that places the candidate in the specified spatial
 * relationship to the target.
 */
export function resolveAnchor(
  anchor: RelativeAnchor,
  targetAABB: AABB,
  candidateLocalAABB: AABB,
): [number, number, number] {
  const margin = anchor.margin ?? 0;

  // Compute candidate half-extents
  const cHalfW = (candidateLocalAABB.max[0] - candidateLocalAABB.min[0]) / 2;
  const cHalfH = (candidateLocalAABB.max[1] - candidateLocalAABB.min[1]) / 2;
  const cHalfD = (candidateLocalAABB.max[2] - candidateLocalAABB.min[2]) / 2;

  // Target center and extents
  const tCenterX = (targetAABB.min[0] + targetAABB.max[0]) / 2;
  const tCenterY = (targetAABB.min[1] + targetAABB.max[1]) / 2;
  const tCenterZ = (targetAABB.min[2] + targetAABB.max[2]) / 2;

  // Compute X alignment
  let x: number;
  switch (anchor.alignX ?? "center") {
    case "min": x = targetAABB.min[0] + cHalfW; break;
    case "max": x = targetAABB.max[0] - cHalfW; break;
    case "center": default: x = tCenterX; break;
  }

  // Compute Z alignment
  let z: number;
  switch (anchor.alignZ ?? "center") {
    case "min": z = targetAABB.min[2] + cHalfD; break;
    case "max": z = targetAABB.max[2] - cHalfD; break;
    case "center": default: z = tCenterZ; break;
  }

  let y = tCenterY;

  switch (anchor.relation) {
    case "on_top_of":
      y = targetAABB.max[1] + cHalfH + margin;
      break;
    case "underneath":
      y = targetAABB.min[1] - cHalfH - margin;
      break;
    case "beside_left":
      x = targetAABB.min[0] - cHalfW - margin;
      y = tCenterY;
      break;
    case "beside_right":
      x = targetAABB.max[0] + cHalfW + margin;
      y = tCenterY;
      break;
    case "in_front_of":
      z = targetAABB.max[2] + cHalfD + margin;
      y = tCenterY;
      break;
    case "behind":
      z = targetAABB.min[2] - cHalfD - margin;
      y = tCenterY;
      break;
    case "centered_on":
      x = tCenterX;
      y = tCenterY;
      z = tCenterZ;
      break;
  }

  return [x, y, z];
}

// ── Cycle detection ──────────────────────────────────────────────────────────

/**
 * Detects whether reparenting `nodeId` under `newParentId` would create a cycle.
 *
 * Walks up from `newParentId` — if it reaches `nodeId` before reaching root,
 * the reparent would make a node its own ancestor.
 */
function wouldCreateCycle(
  nodeId: string,
  newParentId: string,
  nodes: Map<string, SceneNode>,
): boolean {
  let current = newParentId;
  const visited = new Set<string>();
  while (true) {
    if (current === nodeId) return true;
    if (visited.has(current)) return false; // already a cycle in the existing graph
    visited.add(current);
    const parent = nodes.get(current);
    if (parent === undefined || parent.parentId === null) return false;
    current = parent.parentId;
  }
}

// ── Assertion evaluation ─────────────────────────────────────────────────────

function evaluateAssertions(
  assertions: SpatialConstraintAssertion[],
  nodes: Map<string, SceneNode>,
): string[] {
  const failures: string[] = [];

  for (const assertion of assertions) {
    switch (assertion.check) {
      case "no_overlap": {
        const nodeA = nodes.get(assertion.nodeA);
        const nodeB = nodes.get(assertion.nodeB);
        if (nodeA === undefined || nodeB === undefined) {
          failures.push(
            `no_overlap: node '${nodeA === undefined ? assertion.nodeA : assertion.nodeB}' does not exist`,
          );
          break;
        }
        const aabbA = nodeA.nodeType === "group" ? expandGroupAABB(assertion.nodeA, nodes) : nodeA.worldAABB;
        const aabbB = nodeB.nodeType === "group" ? expandGroupAABB(assertion.nodeB, nodes) : nodeB.worldAABB;
        const tolerance = assertion.toleranceMeters ?? 0.005;

        // Check overlap on each axis
        const overlapX = Math.min(aabbA.max[0], aabbB.max[0]) - Math.max(aabbA.min[0], aabbB.min[0]);
        const overlapY = Math.min(aabbA.max[1], aabbB.max[1]) - Math.max(aabbA.min[1], aabbB.min[1]);
        const overlapZ = Math.min(aabbA.max[2], aabbB.max[2]) - Math.max(aabbA.min[2], aabbB.min[2]);

        if (overlapX > tolerance && overlapY > tolerance && overlapZ > tolerance) {
          const maxOverlap = Math.max(overlapX, overlapY, overlapZ);
          const axis = maxOverlap === overlapX ? "X" : maxOverlap === overlapY ? "Y" : "Z";
          failures.push(
            `Node '${assertion.nodeA}' overlaps '${assertion.nodeB}' by ${maxOverlap.toFixed(3)}m on ${axis} axis; ` +
            `shift ${axis} by +${(maxOverlap + 0.01).toFixed(3)}m`,
          );
        }
        break;
      }
      case "grounded_on_floor": {
        const node = nodes.get(assertion.nodeId);
        if (node === undefined) {
          failures.push(`grounded_on_floor: node '${assertion.nodeId}' does not exist`);
          break;
        }
        const aabb = node.nodeType === "group" ? expandGroupAABB(assertion.nodeId, nodes) : node.worldAABB;
        const floorY = assertion.floorY ?? 0;
        const gap = Math.abs(aabb.min[1] - floorY);
        if (gap > 0.01) {
          failures.push(
            `Node '${assertion.nodeId}' is ${gap.toFixed(3)}m ${aabb.min[1] > floorY ? "above" : "below"} floor (y=${floorY}); ` +
            `adjust Y position by ${(floorY - aabb.min[1]).toFixed(3)}m`,
          );
        }
        break;
      }
      case "resting_on": {
        const upper = nodes.get(assertion.upperNodeId);
        const lower = nodes.get(assertion.lowerNodeId);
        if (upper === undefined || lower === undefined) {
          failures.push(
            `resting_on: node '${upper === undefined ? assertion.upperNodeId : assertion.lowerNodeId}' does not exist`,
          );
          break;
        }
        const upperAABB = upper.nodeType === "group" ? expandGroupAABB(assertion.upperNodeId, nodes) : upper.worldAABB;
        const lowerAABB = lower.nodeType === "group" ? expandGroupAABB(assertion.lowerNodeId, nodes) : lower.worldAABB;
        const gap = Math.abs(upperAABB.min[1] - lowerAABB.max[1]);
        if (gap > 0.02) {
          failures.push(
            `Node '${assertion.upperNodeId}' is not resting on '${assertion.lowerNodeId}': ` +
            `gap of ${gap.toFixed(3)}m between upper bottom (${upperAABB.min[1].toFixed(3)}) ` +
            `and lower top (${lowerAABB.max[1].toFixed(3)})`,
          );
        }
        break;
      }
    }
  }

  return failures;
}

// ── Main pipeline ────────────────────────────────────────────────────────────

/**
 * Runs Gates 1 and 2 on raw model output against a committed scene state.
 *
 * Returns a `GateResult` indicating success (with the candidate scene) or
 * failure (with the gate number and diagnostics for repair).
 *
 * **The committed scene is never mutated.** The candidate is built on a
 * `structuredClone`, so this function is safe to retry with different output.
 */
export function runDeterministicBuilder(
  committedScene: SceneState,
  rawOutput: unknown,
): GateResult {
  // ── Gate 1: JSON parse ─────────────────────────────────────────────────────
  let parsed: unknown;
  try {
    const text = typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput);
    const cleaned = extractCleanJson(text);
    parsed = JSON.parse(cleaned);
  } catch (error) {
    return {
      ok: false,
      gate: 1,
      diagnostics: `Gate 1: JSON parse failed — ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // ── Gate 2a: Schema validation ─────────────────────────────────────────────
  const schemaResult = ProceduralStepSchema.safeParse(parsed);
  if (!schemaResult.success) {
    const issues = schemaResult.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    return {
      ok: false,
      gate: 2,
      diagnostics: `Gate 2a: Schema validation failed — ${issues}`,
    };
  }

  const step = schemaResult.data;

  // ── Gate 2b: Referential integrity ─────────────────────────────────────────
  // Clone the scene so a bad step never touches the committed state.
  const candidate = cloneScene(committedScene);
  const integrityErrors: string[] = [];

  for (const op of step.operations) {
    const error = applyOperation(op, candidate);
    if (error !== null) integrityErrors.push(error);
  }

  if (integrityErrors.length > 0) {
    return {
      ok: false,
      gate: 2,
      diagnostics: `Gate 2b: Operation check failed — ${integrityErrors.join("; ")}`,
    };
  }

  // ── Gate 2c: AABB computation, anchor resolution, assertion evaluation ─────
  // Recompute all world AABBs (operations may have changed transforms/geometry)
  recomputeWorldAABBs(candidate);

  // Resolve anchors
  const anchorErrors = resolveAnchors(candidate);
  if (anchorErrors.length > 0) {
    return {
      ok: false,
      gate: 2,
      diagnostics: `Gate 2c: Anchor resolution failed — ${anchorErrors.join("; ")}`,
    };
  }
  // Recompute after anchor resolution updated node positions
  recomputeWorldAABBs(candidate);

  // Evaluate spatial assertions
  const assertionFailures = evaluateAssertions(step.assertions, candidate.nodes);
  if (assertionFailures.length > 0) {
    return {
      ok: false,
      gate: 2,
      diagnostics: `Gate 2c: Assertion check failed — ${assertionFailures.join("; ")}`,
    };
  }

  return { ok: true, gate: "all_passed", candidateScene: candidate, step };
}

// ── Scene cloning & node creation ────────────────────────────────────────────

function cloneScene(scene: SceneState): SceneState {
  const nodes = new Map<string, SceneNode>();
  for (const [id, node] of scene.nodes) {
    nodes.set(id, structuredClone(node));
  }
  return { nodes, revision: scene.revision };
}

function createSceneNode(
  nodeId: string,
  label: string,
  nodeType: "group" | "mesh",
  parentId: string | null,
  transform: TransformSpec,
  geometry?: GeometrySpec,
  material?: MaterialSpec,
): SceneNode {
  const localAABB = geometry !== undefined ? localAABBForGeometry(geometry) : EMPTY_AABB;
  const node: SceneNode = {
    nodeId,
    label,
    nodeType,
    parentId,
    children: [],
    transform,
    localAABB,
    worldAABB: structuredClone(localAABB),
  };
  if (geometry !== undefined) node.geometry = geometry;
  if (material !== undefined) node.material = material;
  return node;
}

// ── Operation application ────────────────────────────────────────────────────

function applyOperation(op: SceneOperation, scene: SceneState): string | null {
  switch (op.op) {
    case "create_node": {
      if (scene.nodes.has(op.nodeId)) {
        return `create_node: nodeId '${op.nodeId}' already exists in the scene`;
      }
      if (op.parentId !== null && !scene.nodes.has(op.parentId)) {
        return `create_node: parentId '${op.parentId}' does not exist`;
      }
      if (op.nodeType === "mesh" && op.geometry === undefined) {
        return `create_node: mesh node '${op.nodeId}' must define geometry`;
      }
      if (op.nodeType === "mesh" && op.material === undefined) {
        return `create_node: mesh node '${op.nodeId}' must define material`;
      }

      const node = createSceneNode(
        op.nodeId,
        op.label,
        op.nodeType,
        op.parentId ?? null,
        op.transform,
        op.geometry,
        op.material,
      );
      scene.nodes.set(op.nodeId, node);

      if (op.parentId !== null) {
        const parent = scene.nodes.get(op.parentId);
        if (parent !== undefined) parent.children.push(op.nodeId);
      }
      return null;
    }

    case "update_transform": {
      const node = scene.nodes.get(op.nodeId);
      if (node === undefined) {
        return `update_transform: nodeId '${op.nodeId}' does not exist`;
      }
      if (op.transform.position !== undefined) node.transform.position = op.transform.position;
      if (op.transform.rotationDeg !== undefined) node.transform.rotationDeg = op.transform.rotationDeg;
      if (op.transform.scale !== undefined) node.transform.scale = op.transform.scale;
      if (op.transform.anchor !== undefined) node.transform.anchor = op.transform.anchor;
      return null;
    }

    case "update_geometry": {
      const node = scene.nodes.get(op.nodeId);
      if (node === undefined) {
        return `update_geometry: nodeId '${op.nodeId}' does not exist`;
      }
      node.geometry = op.geometry;
      node.localAABB = localAABBForGeometry(op.geometry);
      return null;
    }

    case "update_material": {
      const node = scene.nodes.get(op.nodeId);
      if (node === undefined) {
        return `update_material: nodeId '${op.nodeId}' does not exist`;
      }
      if (node.material === undefined) {
        node.material = op.material as MaterialSpec;
      } else {
        Object.assign(node.material, op.material);
      }
      return null;
    }

    case "reparent_node": {
      const node = scene.nodes.get(op.nodeId);
      if (node === undefined) {
        return `reparent_node: nodeId '${op.nodeId}' does not exist`;
      }
      if (op.newParentId !== null && !scene.nodes.has(op.newParentId)) {
        return `reparent_node: newParentId '${op.newParentId}' does not exist`;
      }
      if (op.newParentId !== null && wouldCreateCycle(op.nodeId, op.newParentId, scene.nodes)) {
        return `reparent_node: reparenting '${op.nodeId}' under '${op.newParentId}' would create a cycle`;
      }

      // Remove from old parent
      if (node.parentId !== null) {
        const oldParent = scene.nodes.get(node.parentId);
        if (oldParent !== undefined) {
          oldParent.children = oldParent.children.filter((id) => id !== op.nodeId);
        }
      }

      // Add to new parent
      node.parentId = op.newParentId;
      if (op.newParentId !== null) {
        const newParent = scene.nodes.get(op.newParentId);
        if (newParent !== undefined) newParent.children.push(op.nodeId);
      }
      return null;
    }

    case "delete_node": {
      const node = scene.nodes.get(op.nodeId);
      if (node === undefined) {
        return `delete_node: nodeId '${op.nodeId}' does not exist`;
      }

      // Remove from parent
      if (node.parentId !== null) {
        const parent = scene.nodes.get(node.parentId);
        if (parent !== undefined) {
          parent.children = parent.children.filter((id) => id !== op.nodeId);
        }
      }

      // Recursively delete children
      const toDelete = [op.nodeId];
      while (toDelete.length > 0) {
        const id = toDelete.pop()!;
        const n = scene.nodes.get(id);
        if (n !== undefined) {
          toDelete.push(...n.children);
          scene.nodes.delete(id);
        }
      }
      return null;
    }
  }
}

// ── World AABB recomputation ─────────────────────────────────────────────────

function recomputeWorldAABBs(scene: SceneState): void {
  for (const [nodeId, node] of scene.nodes) {
    node.worldAABB = computeWorldAABB(nodeId, scene.nodes);
  }
}

// ── Anchor resolution pass ───────────────────────────────────────────────────

function resolveAnchors(scene: SceneState): string[] {
  const errors: string[] = [];

  for (const [, node] of scene.nodes) {
    const anchor = node.transform.anchor;
    if (anchor === undefined) continue;

    const target = scene.nodes.get(anchor.targetNodeId);
    if (target === undefined) {
      errors.push(`Anchor target '${anchor.targetNodeId}' for node '${node.nodeId}' does not exist`);
      continue;
    }

    const targetAABB = target.nodeType === "group"
      ? expandGroupAABB(anchor.targetNodeId, scene.nodes)
      : target.worldAABB;

    const resolved = resolveAnchor(anchor, targetAABB, node.localAABB);
    node.transform.position = resolved;
  }

  return errors;
}

// ── Utility exports for testing ──────────────────────────────────────────────

/** Creates an empty scene state for testing. */
export function emptyScene(revision = 0): SceneState {
  return { nodes: new Map(), revision };
}

/** Creates a scene state from a list of nodes for testing. */
export function sceneFromNodes(nodes: SceneNode[], revision = 0): SceneState {
  const map = new Map<string, SceneNode>();
  for (const node of nodes) map.set(node.nodeId, node);
  return { nodes: map, revision };
}
