/**
 * Constrained scene patches.
 *
 * A patch is a small, closed-vocabulary edit against a known base revision: set a
 * parameter, replace a transform, swap a material, rename, add or remove a node.
 * There is deliberately no "run this script" operation — the agent and the
 * inspector speak the same language, and every sentence in it is validatable.
 *
 * Atomicity: `applyPatch` clones the input and works on the clone, so a patch
 * whose third operation fails returns an error and leaves the caller's scene
 * untouched. The result re-validates before it is returned.
 */

import type { Result } from "@nap/shared/result";
import { z } from "zod";
import {
  MAX_DIMENSION_M,
  MAX_HEIGHT_SEGMENTS,
  MAX_PATCH_OPS,
  MAX_RADIAL_SEGMENTS,
  MIN_DIMENSION_M,
  MIN_HEIGHT_SEGMENTS,
  MIN_RADIAL_SEGMENTS,
} from "./limits.ts";
import { NodeIdSchema, type SceneSpec, TransformSchema, validateSceneSpec } from "./schema.ts";

export const SetParamOpSchema = z.strictObject({
  op: z.literal("set_param"),
  nodeId: NodeIdSchema,
  key: z.string().min(1).max(32),
  value: z.number(),
});

export const SetTransformOpSchema = z.strictObject({
  op: z.literal("set_transform"),
  nodeId: NodeIdSchema,
  transform: TransformSchema,
});

export const SetMaterialOpSchema = z.strictObject({
  op: z.literal("set_material"),
  nodeId: NodeIdSchema,
  materialId: z.string().min(1).max(64),
});

export const RenameOpSchema = z.strictObject({
  op: z.literal("rename"),
  nodeId: NodeIdSchema,
  name: z.string().min(1).max(80),
});

export const RemoveNodeOpSchema = z.strictObject({
  op: z.literal("remove_node"),
  nodeId: NodeIdSchema,
});

export const PatchOpSchema = z.discriminatedUnion("op", [
  SetParamOpSchema,
  SetTransformOpSchema,
  SetMaterialOpSchema,
  RenameOpSchema,
  RemoveNodeOpSchema,
  z.strictObject({
    op: z.literal("add_node"),
    parentId: NodeIdSchema,
    // The node arrives as unknown and is validated on insertion — an add carrying
    // a malformed node must fail the patch, not the patch parser.
    node: z.unknown(),
  }),
]);
export type PatchOp = z.infer<typeof PatchOpSchema>;

export const ScenePatchSchema = z.strictObject({
  baseRevision: z.string().regex(/^[0-9a-f]{64}$/, { message: "must be a sha-256 hex hash" }),
  ops: z.array(PatchOpSchema).min(1).max(MAX_PATCH_OPS),
});
export type ScenePatch = z.infer<typeof ScenePatchSchema>;

export type PatchError = {
  code:
    | "invalid_patch"
    | "stale_base"
    | "unknown_node"
    | "unknown_parent"
    | "not_procedural"
    | "unknown_param"
    | "invalid_value"
    | "unknown_material"
    | "duplicate_node_id"
    | "cannot_remove_root"
    | "invalid_result";
  message: string;
};

/**
 * Parameters each operation exposes for editing. The inspector and the agent may
 * only address these keys — anything else is `unknown_param`, which keeps a renamed
 * internal field from silently becoming a no-op edit.
 */
const EDITABLE_PARAMS: Record<string, readonly string[]> = {
  box: ["width", "height", "depth", "bevel"],
  cylinder: ["radiusTop", "radiusBottom", "height", "radialSegments", "heightSegments"],
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Apply `patch` to `spec`, returning the new spec without mutating the input.
 * `baseHash` is the canonical hash the caller built the patch against; a mismatch
 * means another edit landed first and the patch is stale, not wrong.
 */
export function applyPatch(
  spec: SceneSpec,
  patch: ScenePatch,
  baseHash: string,
): Result<SceneSpec, PatchError> {
  if (patch.baseRevision !== baseHash) {
    return {
      ok: false,
      error: {
        code: "stale_base",
        message: `patch targets ${shortHash(patch.baseRevision)} but the scene is at ${shortHash(baseHash)}`,
      },
    };
  }

  // Deep clone up front: every failure path below returns before this draft escapes,
  // so the caller's spec is never partially modified.
  const draft: SceneSpec = structuredClone(spec);
  const byId = new Map(draft.nodes.map((node) => [node.id, node]));

  for (let index = 0; index < patch.ops.length; index += 1) {
    const op = patch.ops[index];
    if (op === undefined) continue;
    const failure = applyOp(draft, byId, op, index);
    if (failure !== undefined) return { ok: false, error: failure };
  }

  const revalidated = validateSceneSpec(draft);
  if (!revalidated.ok) {
    return {
      ok: false,
      error: {
        code: "invalid_result",
        message: `patch yields an invalid scene: ${revalidated.error.message}`,
      },
    };
  }
  return { ok: true, value: revalidated.value };
}

function applyOp(
  draft: SceneSpec,
  byId: Map<string, SceneSpec["nodes"][number]>,
  op: PatchOp,
  index: number,
): PatchError | undefined {
  switch (op.op) {
    case "set_param": {
      const node = byId.get(op.nodeId);
      if (node === undefined) return unknownNode(op.nodeId, index);
      if (node.kind !== "procedural") {
        return {
          code: "not_procedural",
          message: `${where(index, op)} node "${op.nodeId}" has no editable parameters`,
        };
      }
      const editable = EDITABLE_PARAMS[node.op] ?? [];
      if (!editable.includes(op.key)) {
        return {
          code: "unknown_param",
          message:
            `${where(index, op)} "${op.key}" is not an editable parameter of ${node.op} ` +
            `(editable: ${editable.join(", ")})`,
        };
      }
      if (!isFiniteNumber(op.value)) {
        return {
          code: "invalid_value",
          message: `${where(index, op)} "${op.key}" must be a finite number, got ${op.value}`,
        };
      }
      const paramError = checkParamValue(node.op, node.params, op.key, op.value);
      if (paramError !== undefined) {
        return {
          code: "invalid_value",
          message: `${where(index, op)} "${op.key}" on "${op.nodeId}": got ${op.value} — ${paramError}`,
        };
      }
      (node.params as Record<string, unknown>)[op.key] = op.value;
      return undefined;
    }
    case "set_transform": {
      const node = byId.get(op.nodeId);
      if (node === undefined) return unknownNode(op.nodeId, index);
      node.transform = op.transform;
      return undefined;
    }
    case "set_material": {
      const node = byId.get(op.nodeId);
      if (node === undefined) return unknownNode(op.nodeId, index);
      if (node.kind !== "procedural") {
        return {
          code: "not_procedural",
          message: `${where(index, op)} node "${op.nodeId}" carries no material`,
        };
      }
      const available = draft.materials.map((material) => material.id);
      if (!available.includes(op.materialId)) {
        return {
          code: "unknown_material",
          message:
            `${where(index, op)} unknown material "${op.materialId}"` +
            (available.length > 0
              ? ` (available: ${available.join(", ")})`
              : " (the scene carries no materials)") +
            ` — add the material to the scene first, or pick one it already carries`,
        };
      }
      node.materialId = op.materialId;
      return undefined;
    }
    case "rename": {
      const node = byId.get(op.nodeId);
      if (node === undefined) return unknownNode(op.nodeId, index);
      node.name = op.name;
      return undefined;
    }
    case "remove_node": {
      const node = byId.get(op.nodeId);
      if (node === undefined) return unknownNode(op.nodeId, index);
      if (op.nodeId === draft.root) {
        return { code: "cannot_remove_root", message: "the root node cannot be removed" };
      }
      // Detach from every group first, then drop the subtree, so no dangling child
      // reference survives even if validation below were ever skipped.
      for (const other of draft.nodes) {
        if (other.kind === "group") {
          other.children = other.children.filter((childId) => childId !== op.nodeId);
        }
      }
      const doomed = new Set<string>([op.nodeId]);
      const stack = [node];
      while (stack.length > 0) {
        const current = stack.pop();
        if (current === undefined || current.kind !== "group") continue;
        for (const childId of current.children) {
          if (doomed.has(childId)) continue;
          doomed.add(childId);
          const child = byId.get(childId);
          if (child !== undefined) stack.push(child);
        }
      }
      draft.nodes = draft.nodes.filter((candidate) => !doomed.has(candidate.id));
      for (const id of doomed) byId.delete(id);
      return undefined;
    }
    case "add_node": {
      const parent = byId.get(op.parentId);
      if (parent === undefined) {
        return { code: "unknown_parent", message: `parent "${op.parentId}" names no node` };
      }
      if (parent.kind !== "group") {
        return { code: "unknown_parent", message: `parent "${op.parentId}" is not a group` };
      }
      const parsed = validateSceneSpec({
        ...structuredClone(draft),
        nodes: [...structuredClone(draft.nodes), op.node],
      });
      if (!parsed.ok) {
        const duplicate =
          typeof op.node === "object" && op.node !== null && "id" in op.node
            ? String((op.node as { id: unknown }).id)
            : "?";
        if (byId.has(duplicate)) {
          return {
            code: "duplicate_node_id",
            message: `a node named "${duplicate}" already exists`,
          };
        }
        return { code: "invalid_value", message: `added node is invalid: ${parsed.error.message}` };
      }
      const added = parsed.value.nodes[parsed.value.nodes.length - 1];
      if (added === undefined) {
        return { code: "invalid_value", message: "added node vanished during validation" };
      }
      draft.nodes.push(added);
      const stored = draft.nodes[draft.nodes.length - 1];
      if (stored === undefined) {
        return { code: "invalid_value", message: "added node vanished during validation" };
      }
      byId.set(added.id, stored);
      parent.children.push(added.id);
      return undefined;
    }
  }
}

function unknownNode(nodeId: string, index: number): PatchError {
  return { code: "unknown_node", message: `op ${index}: node "${nodeId}" does not exist` };
}

/**
 * Where an operation sits in its patch, e.g. `op 2 (set_param)`.
 *
 * Every operation-level diagnostic starts with this so a rejected multi-op
 * patch names the exact operation to fix rather than leaving the caller to
 * count.
 */
function where(index: number, op: PatchOp): string {
  return `op ${index} (${op.op})`;
}

/** Integer-only parameter bounds, from the same limits the schema enforces. */
const INTEGER_PARAMS: Record<string, { min: number; max: number }> = {
  radialSegments: { min: MIN_RADIAL_SEGMENTS, max: MAX_RADIAL_SEGMENTS },
  heightSegments: { min: MIN_HEIGHT_SEGMENTS, max: MAX_HEIGHT_SEGMENTS },
};

/** Linear-dimension parameters, bounded by the schema's dimension range. */
const DIMENSION_PARAMS: ReadonlySet<string> = new Set([
  "width",
  "height",
  "depth",
  "radiusTop",
  "radiusBottom",
]);

/**
 * Check one parameter value against the target operation's own constraints —
 * the same bounds `schema.ts` enforces — so a bad value fails here with the
 * parameter named instead of collapsing into a generic `invalid_result` after
 * the whole patch applied. Returns the constraint description, or undefined
 * when the value is acceptable.
 *
 * The bevel bound reads the node's live dimensions (with the new value merged
 * in when the edit targets a dimension itself), matching the schema's "at most
 * half the smallest dimension" rule for the state this operation produces.
 * Cross-operation interactions (e.g. bevel now, shrink the box two ops later)
 * still fall through to the final revalidation — atomicity is unchanged.
 */
function checkParamValue(
  nodeOp: string,
  params: Record<string, unknown>,
  key: string,
  value: number,
): string | undefined {
  const integer = INTEGER_PARAMS[key];
  if (integer !== undefined) {
    if (!Number.isInteger(value)) {
      return `${key} must be an integer in [${integer.min}, ${integer.max}] — use ${Math.round(value)} or another whole number`;
    }
    if (value < integer.min || value > integer.max) {
      return `${key} must be an integer in [${integer.min}, ${integer.max}]`;
    }
    return undefined;
  }
  if (DIMENSION_PARAMS.has(key)) {
    if (value < MIN_DIMENSION_M || value > MAX_DIMENSION_M) {
      return `${key} must be in [${MIN_DIMENSION_M}, ${MAX_DIMENSION_M}] meters`;
    }
    return undefined;
  }
  if (key === "bevel" && nodeOp === "box") {
    if (value < 0 || value > MAX_DIMENSION_M) {
      return `bevel must be in [0, ${MAX_DIMENSION_M}] meters`;
    }
    const dims = ["width", "height", "depth"].map((dim) => (dim === key ? value : params[dim]));
    if (dims.every((dim) => typeof dim === "number" && Number.isFinite(dim))) {
      const smallest = Math.min(...(dims as number[]));
      const limit = smallest / 2;
      if (value > limit) {
        return `bevel must be at most half the smallest dimension (${limit} m for a smallest dimension of ${smallest} m)`;
      }
    }
    return undefined;
  }
  return undefined;
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}
