/**
 * Core validation schemas for the ThreePod multi-model turn pipeline.
 *
 * This module defines the strict Zod contracts governing inter-stage communication
 * across the multi-model architecture:
 *
 *   1. Multimodal Intake (GPT Luna) → `IntakeIntentSchema`
 *      Extracts 3D spatial intent, bounding proportions, part hierarchy, primitive shapes,
 *      and PBR materials from user text and reference images.
 *
 *   2. Scene Planning & Decomposition (DeepSeek-R1) → `ScenePlanOutputSchema`
 *      Performs ambiguity / safety analysis, pausing for user input (`needs_input`)
 *      or generating an ordered sequence of sub-assembly build steps (`ready`).
 *
 *   3. Procedural Geometry (Qwen 2.5 Coder) → `ProceduralStepSchema`
 *      Generates discrete scene operations (`SceneOperationSchema`) and spatial
 *      assertions (`SpatialConstraintAssertionSchema`) validated at Gates 1 & 2.
 *
 *   4. Visual Validation (GPT Luna) → `VisionAssessmentSchema`
 *      Evaluates rendered candidate scene screenshots at Gate 3 for structural
 *      completeness, physical plausibility, and visual alignment.
 *
 * Rules governing these shapes:
 *   - Payloads are strict: unrecognized keys fail validation to prevent silent drift.
 *   - Units are meters in a Y-up right-handed coordinate system (+X right, +Y up, +Z forward).
 *   - Geometry primitives and relative surface anchors are strictly typed.
 */

import { z } from "zod";

// ── Shared Primitives ────────────────────────────────────────────────────────

/**
 * 3D vector schema: a 3-tuple of finite numbers representing [x, y, z].
 *
 * Used for position translation (meters), Euler rotation angles (degrees, XYZ order),
 * and axis scaling factors.
 */
export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof Vec3Schema>;

/**
 * Valid hexadecimal color string matching standard 3-digit or 6-digit hex format (#rgb or #rrggbb).
 */
export const HexColorSchema = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, {
  message: "must be a valid hex color string (e.g. #ff0000 or #f00)",
});
export type HexColor = z.infer<typeof HexColorSchema>;

// ── Multimodal Intake Schemas ────────────────────────────────────────────────

/**
 * Primitive shape hints supported by the procedural geometry pipeline.
 */
export const PRIMITIVE_HINTS = ["box", "cylinder", "sphere", "cone", "torus", "capsule"] as const;

export const PrimitiveHintSchema = z.enum(PRIMITIVE_HINTS);
export type PrimitiveHint = z.infer<typeof PrimitiveHintSchema>;

/**
 * A discrete component part identified during multimodal intake.
 */
export const IdentifiedPartSchema = z.strictObject({
  partName: z.string().min(1),
  primitiveHint: PrimitiveHintSchema,
  materialHint: z.string().min(1),
});
export type IdentifiedPart = z.infer<typeof IdentifiedPartSchema>;

/**
 * Estimated real-world bounding proportions in meters.
 */
export const ExtractedProportionsSchema = z.strictObject({
  overallWidthMeters: z.number().positive(),
  overallHeightMeters: z.number().positive(),
  overallDepthMeters: z.number().positive(),
});
export type ExtractedProportions = z.infer<typeof ExtractedProportionsSchema>;

/**
 * Structured output from the multimodal intake parser (GPT Luna).
 *
 * Captures core intent, dimensions, component parts, and any missing constraints
 * that prevent 3D construction without guessing.
 */
export const IntakeIntentSchema = z.strictObject({
  parsedIntent: z.string().min(1),
  extractedProportions: ExtractedProportionsSchema,
  identifiedParts: z.array(IdentifiedPartSchema),
  missingConstraints: z.array(z.string()),
});
export type IntakeIntent = z.infer<typeof IntakeIntentSchema>;

// ── Scene Planner Schemas ────────────────────────────────────────────────────

/**
 * Output when the Scene Planner detects essential ambiguity or missing constraints.
 * Pauses the pipeline and prompts the user for clarification.
 */
export const ScenePlanNeedsInputSchema = z.strictObject({
  status: z.literal("needs_input"),
  ambiguityReason: z.string().min(1),
  questionsForUser: z.array(z.string().min(1)).min(1).max(3),
});
export type ScenePlanNeedsInput = z.infer<typeof ScenePlanNeedsInputSchema>;

/**
 * A single atomic sub-assembly build step in an approved scene plan.
 */
export const ScenePlanAtomicStepSchema = z.strictObject({
  stepIndex: z.number().int().nonnegative(),
  stepId: z.string().regex(/^[a-z0-9_-]+$/, {
    message: "must be alphanumeric with underscores or hyphens",
  }),
  goal: z.string().min(1),
  targetNodes: z.array(z.string()),
  spatialConstraints: z.array(z.string()),
});
export type ScenePlanAtomicStep = z.infer<typeof ScenePlanAtomicStepSchema>;

/**
 * Output when the Scene Planner confirms sufficient clarity and produces
 * an ordered list of atomic construction steps.
 */
export const ScenePlanReadySchema = z.strictObject({
  status: z.literal("ready"),
  sceneSummary: z.string().min(1),
  atomicSteps: z.array(ScenePlanAtomicStepSchema).min(1).max(12),
});
export type ScenePlanReady = z.infer<typeof ScenePlanReadySchema>;

/**
 * The full output union of the Scene Planner (DeepSeek-R1).
 */
export const ScenePlanOutputSchema = z.discriminatedUnion("status", [
  ScenePlanNeedsInputSchema,
  ScenePlanReadySchema,
]);
export type ScenePlanOutput = z.infer<typeof ScenePlanOutputSchema>;

// ── Geometry & Transform Schemas ─────────────────────────────────────────────

export const BoxGeometrySpecSchema = z.strictObject({
  kind: z.literal("box"),
  width: z.number().positive(),
  height: z.number().positive(),
  depth: z.number().positive(),
  bevelRadius: z.number().min(0).default(0),
});
export type BoxGeometrySpec = z.infer<typeof BoxGeometrySpecSchema>;

export const CylinderGeometrySpecSchema = z.strictObject({
  kind: z.literal("cylinder"),
  radiusTop: z.number().min(0),
  radiusBottom: z.number().min(0),
  height: z.number().positive(),
  radialSegments: z.number().int().min(8).max(128).default(32),
});
export type CylinderGeometrySpec = z.infer<typeof CylinderGeometrySpecSchema>;

export const SphereGeometrySpecSchema = z.strictObject({
  kind: z.literal("sphere"),
  radius: z.number().positive(),
  widthSegments: z.number().int().min(8).max(128).default(32),
});
export type SphereGeometrySpec = z.infer<typeof SphereGeometrySpecSchema>;

export const ConeGeometrySpecSchema = z.strictObject({
  kind: z.literal("cone"),
  radius: z.number().positive(),
  height: z.number().positive(),
  radialSegments: z.number().int().min(8).max(128).default(32),
});
export type ConeGeometrySpec = z.infer<typeof ConeGeometrySpecSchema>;

export const TorusGeometrySpecSchema = z.strictObject({
  kind: z.literal("torus"),
  radius: z.number().positive(),
  tube: z.number().positive(),
  arc: z
    .number()
    .positive()
    .max(Math.PI * 2)
    .default(Math.PI * 2),
});
export type TorusGeometrySpec = z.infer<typeof TorusGeometrySpecSchema>;

export const CapsuleGeometrySpecSchema = z.strictObject({
  kind: z.literal("capsule"),
  radius: z.number().positive(),
  length: z.number().positive(),
});
export type CapsuleGeometrySpec = z.infer<typeof CapsuleGeometrySpecSchema>;

/**
 * Discriminated union of procedural geometry specifications supported by the builder.
 */
export const GeometrySpecSchema = z.discriminatedUnion("kind", [
  BoxGeometrySpecSchema,
  CylinderGeometrySpecSchema,
  SphereGeometrySpecSchema,
  ConeGeometrySpecSchema,
  TorusGeometrySpecSchema,
  CapsuleGeometrySpecSchema,
]);
export type GeometrySpec = z.infer<typeof GeometrySpecSchema>;

/**
 * PBR material specification for procedural mesh nodes.
 */
export const MaterialSpecSchema = z.strictObject({
  color: HexColorSchema,
  roughness: z.number().min(0).max(1).default(0.5),
  metalness: z.number().min(0).max(1).default(0.0),
  opacity: z.number().min(0).max(1).default(1.0),
  emissive: HexColorSchema.optional(),
  emissiveIntensity: z.number().min(0).max(10).optional(),
});
export type MaterialSpec = z.infer<typeof MaterialSpecSchema>;

/**
 * Supported spatial relationships for relative anchoring between nodes.
 */
export const SPATIAL_RELATIONS = [
  "on_top_of",
  "beside_left",
  "beside_right",
  "in_front_of",
  "behind",
  "underneath",
  "centered_on",
] as const;
export const SpatialRelationSchema = z.enum(SPATIAL_RELATIONS);
export type SpatialRelation = z.infer<typeof SpatialRelationSchema>;

/**
 * Axis alignment options when resolving relative anchors.
 */
export const ANCHOR_ALIGNMENTS = ["min", "center", "max"] as const;
export const AnchorAlignmentSchema = z.enum(ANCHOR_ALIGNMENTS);
export type AnchorAlignment = z.infer<typeof AnchorAlignmentSchema>;

/**
 * Relative spatial anchor specification.
 *
 * Allows placing a node relative to another existing node based on world AABBs
 * rather than guessing absolute global coordinates.
 */
export const RelativeAnchorSchema = z.strictObject({
  targetNodeId: z.string().min(1),
  relation: SpatialRelationSchema,
  margin: z.number().min(0).default(0),
  alignX: AnchorAlignmentSchema.default("center"),
  alignZ: AnchorAlignmentSchema.default("center"),
});
export type RelativeAnchor = z.infer<typeof RelativeAnchorSchema>;

/**
 * Transform specification for 3D scene nodes.
 *
 * Includes local position, rotation in degrees, scale, and an optional relative anchor.
 */
export const TransformSpecSchema = z.strictObject({
  position: Vec3Schema.default([0, 0, 0]),
  rotationDeg: Vec3Schema.default([0, 0, 0]),
  scale: Vec3Schema.default([1, 1, 1]),
  anchor: RelativeAnchorSchema.optional(),
});
export type TransformSpec = z.infer<typeof TransformSpecSchema>;

// ── Scene Operation Schemas ──────────────────────────────────────────────────

/**
 * Creates a new node in the scene tree.
 *
 * Groups act as structural containers; meshes hold renderable geometry and materials.
 */
export const CreateNodeOpSchema = z.strictObject({
  op: z.literal("create_node"),
  nodeId: z.string().regex(/^[a-z0-9_]+$/, { message: "must be snake_case alphanumeric" }),
  label: z.string().min(1),
  nodeType: z.enum(["group", "mesh"]),
  parentId: z.string().nullable().optional().default(null),
  transform: TransformSpecSchema.default({
    position: [0, 0, 0],
    rotationDeg: [0, 0, 0],
    scale: [1, 1, 1],
  }),
  geometry: GeometrySpecSchema.optional(),
  material: MaterialSpecSchema.optional(),
});
export type CreateNodeOp = z.infer<typeof CreateNodeOpSchema>;

/**
 * Partial transform update specification.
 */
export const UpdateTransformSpecSchema = z.strictObject({
  position: Vec3Schema.optional(),
  rotationDeg: Vec3Schema.optional(),
  scale: Vec3Schema.optional(),
  anchor: RelativeAnchorSchema.optional(),
});
export type UpdateTransformSpec = z.infer<typeof UpdateTransformSpecSchema>;

/**
 * Updates the transform properties of an existing node.
 */
export const UpdateTransformOpSchema = z.strictObject({
  op: z.literal("update_transform"),
  nodeId: z.string().min(1),
  transform: UpdateTransformSpecSchema,
});
export type UpdateTransformOp = z.infer<typeof UpdateTransformOpSchema>;

/**
 * Updates the geometry specification of an existing mesh node.
 */
export const UpdateGeometryOpSchema = z.strictObject({
  op: z.literal("update_geometry"),
  nodeId: z.string().min(1),
  geometry: GeometrySpecSchema,
});
export type UpdateGeometryOp = z.infer<typeof UpdateGeometryOpSchema>;

/**
 * Partial material update specification.
 */
export const UpdateMaterialSpecSchema = z.strictObject({
  color: HexColorSchema.optional(),
  roughness: z.number().min(0).max(1).optional(),
  metalness: z.number().min(0).max(1).optional(),
  opacity: z.number().min(0).max(1).optional(),
  emissive: HexColorSchema.optional(),
  emissiveIntensity: z.number().min(0).max(10).optional(),
});
export type UpdateMaterialSpec = z.infer<typeof UpdateMaterialSpecSchema>;

/**
 * Updates material properties of an existing mesh node.
 */
export const UpdateMaterialOpSchema = z.strictObject({
  op: z.literal("update_material"),
  nodeId: z.string().min(1),
  material: UpdateMaterialSpecSchema,
});
export type UpdateMaterialOp = z.infer<typeof UpdateMaterialOpSchema>;

/**
 * Reparents an existing node under a new parent or to the scene root (null).
 */
export const ReparentNodeOpSchema = z.strictObject({
  op: z.literal("reparent_node"),
  nodeId: z.string().min(1),
  newParentId: z.string().min(1).nullable(),
});
export type ReparentNodeOp = z.infer<typeof ReparentNodeOpSchema>;

/**
 * Deletes an existing node and its descendant subtree.
 */
export const DeleteNodeOpSchema = z.strictObject({
  op: z.literal("delete_node"),
  nodeId: z.string().min(1),
});
export type DeleteNodeOp = z.infer<typeof DeleteNodeOpSchema>;

/**
 * Discriminated union of operations that can modify scene graph state.
 */
export const SceneOperationSchema = z.discriminatedUnion("op", [
  CreateNodeOpSchema,
  UpdateTransformOpSchema,
  UpdateGeometryOpSchema,
  UpdateMaterialOpSchema,
  ReparentNodeOpSchema,
  DeleteNodeOpSchema,
]);
export type SceneOperation = z.infer<typeof SceneOperationSchema>;

// ── Spatial Constraint Assertions ────────────────────────────────────────────

/**
 * Asserts that two nodes do not collide or interpenetrate beyond tolerance.
 */
export const NoOverlapAssertionSchema = z.strictObject({
  check: z.literal("no_overlap"),
  nodeA: z.string().min(1),
  nodeB: z.string().min(1),
  toleranceMeters: z.number().min(0).default(0.005).optional(),
});
export type NoOverlapAssertion = z.infer<typeof NoOverlapAssertionSchema>;

/**
 * Asserts that the bottom bounds of a node touch the floor plane (y = 0 by default).
 */
export const GroundedOnFloorAssertionSchema = z.strictObject({
  check: z.literal("grounded_on_floor"),
  nodeId: z.string().min(1),
  floorY: z.number().default(0).optional(),
});
export type GroundedOnFloorAssertion = z.infer<typeof GroundedOnFloorAssertionSchema>;

/**
 * Asserts that the upper node rests cleanly on top of the lower node.
 */
export const RestingOnAssertionSchema = z.strictObject({
  check: z.literal("resting_on"),
  upperNodeId: z.string().min(1),
  lowerNodeId: z.string().min(1),
});
export type RestingOnAssertion = z.infer<typeof RestingOnAssertionSchema>;

/**
 * Discriminated union of spatial constraint assertions evaluated at Gate 2c.
 */
export const SpatialConstraintAssertionSchema = z.discriminatedUnion("check", [
  NoOverlapAssertionSchema,
  GroundedOnFloorAssertionSchema,
  RestingOnAssertionSchema,
]);
export type SpatialConstraintAssertion = z.infer<typeof SpatialConstraintAssertionSchema>;

// ── Procedural Step Schema ───────────────────────────────────────────────────

/**
 * Complete procedural step emitted by the Geometry Planner (Qwen 2.5 Coder).
 *
 * Contains discrete operations to construct/update scene nodes and spatial
 * assertions to verify physical correctness deterministically.
 */
export const ProceduralStepSchema = z.strictObject({
  stepId: z.string().min(1),
  intentSummary: z.string().min(1),
  operations: z.array(SceneOperationSchema).min(1).max(25),
  assertions: z.array(SpatialConstraintAssertionSchema).default([]),
});
export type ProceduralStep = z.infer<typeof ProceduralStepSchema>;

// ── Gate 3 Vision Validator Schema ───────────────────────────────────────────

/**
 * Assessment produced by the Gate 3 Vision Validator (GPT Luna).
 *
 * Inspects rendered screenshots of candidate scenes to verify visual completeness,
 * spatial plausibility, and material fidelity.
 */
export const VisionAssessmentSchema = z.strictObject({
  accepted: z.boolean(),
  score: z.number().min(0).max(100),
  observedIssues: z.array(z.string()),
  targetedRevisionRequest: z.string().nullable(),
});
export type VisionAssessment = z.infer<typeof VisionAssessmentSchema>;
