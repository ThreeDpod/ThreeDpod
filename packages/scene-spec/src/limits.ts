/**
 * Structural resource limits for scene specifications.
 *
 * These bound what a single scene may describe, so a malformed or hostile spec
 * cannot force the builder into unbounded work. Every limit here is enforced by
 * `schema.ts` validation and re-checked by the procedural engine before building.
 * The numbers are starting points for a prototype editor, not tuned production
 * ceilings — raising one later must update the tests that pin it.
 */

import { z } from "zod";

/** Schema versions this package understands. Version 1 is the only one yet. */
export const SCENE_SPEC_VERSION = 1 as const;

/** Maximum nodes in one scene, counting groups and geometry leaves together. */
export const MAX_NODES = 256;

/** Maximum nesting depth below the root, so a cyclic or runaway hierarchy fails fast. */
export const MAX_DEPTH = 16;

/** Maximum materials in one scene. */
export const MAX_MATERIALS = 64;

/** Maximum children one group may name. */
export const MAX_CHILDREN = 64;

/** Maximum operations in a single patch — large edits arrive as several patches. */
export const MAX_PATCH_OPS = 64;

/** Maximum triangles one built scene may contain. Enforced by the engine, not the schema. */
export const MAX_TRIANGLES = 500_000;

/**
 * Maximum canonical bytes of one scene revision traveling the event log.
 *
 * No existing transport imposes this: notify frames carry only session/seq, WS
 * frames have no coded cap in the stream, and jsonb is effectively unbounded.
 * It exists so a future operation set cannot silently grow revisions past what
 * a log frame sanely carries. The v1 schema caps (~77KB for 256 dense nodes)
 * cannot reach it — enforced anyway, so growth trips a named rejection instead
 * of a mysterious transport failure. Tune with measurement: raise only
 * alongside a larger schema or op set.
 */
export const MAX_SCENE_EVENT_BYTES = 256 * 1024;

/** Smallest and largest linear dimension, in meters. */
export const MIN_DIMENSION_M = 0.001;
export const MAX_DIMENSION_M = 100;

/** Radial segment bounds for curved primitives. */
export const MIN_RADIAL_SEGMENTS = 3;
export const MAX_RADIAL_SEGMENTS = 128;

/** Height segment bounds for curved primitives. */
export const MIN_HEIGHT_SEGMENTS = 1;
export const MAX_HEIGHT_SEGMENTS = 64;

/** A finite number — NaN and both infinities are never valid scene data. */
export function finiteNumber() {
  return z.number().refine((n) => Number.isFinite(n), {
    message: "must be a finite number",
  });
}

/**
 * A strictly positive finite number — zero and negative scales or dimensions
 * would invert or collapse geometry, so they are rejected rather than clamped.
 */
export function positiveSize() {
  return z.number().refine((n) => Number.isFinite(n) && n > 0, {
    message: "must be a positive finite number",
  });
}
