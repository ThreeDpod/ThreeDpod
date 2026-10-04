/**
 * The canonical example scene: a three-tier box tower.
 *
 * One fixture shared by the schema tests, the engine tests and the web viewport,
 * so "the tower" means the same numbers everywhere. Dimensions are exact decimals
 * in meters: a 2×2×1 base, a 1.4×1.4×1 middle, a 0.8×0.8×2 top, stacked with
 * butt joints on a root group at the origin.
 */

import type { SceneSpec } from "./schema.ts";

export const TOWER_BASE_ID = "base";
export const TOWER_MID_ID = "mid";
export const TOWER_TOP_ID = "top";
export const TOWER_ROOT_ID = "tower";
export const TOWER_MATERIAL_ID = "concrete";

export function towerSpec(): SceneSpec {
  return {
    version: 1,
    id: "00000000-0000-4000-8000-000000000001",
    seed: 7,
    units: "m",
    axes: "y-up",
    materials: [
      { id: TOWER_MATERIAL_ID, name: "Concrete", color: "#9aa0a6", metalness: 0, roughness: 0.9 },
    ],
    nodes: [
      {
        kind: "group",
        id: TOWER_ROOT_ID,
        name: "Tower",
        transform: {
          position: [0, 0, 0],
          rotationEuler: [0, 0, 0],
          scale: [1, 1, 1],
        },
        children: [TOWER_BASE_ID, TOWER_MID_ID, TOWER_TOP_ID],
      },
      {
        kind: "procedural",
        id: TOWER_BASE_ID,
        name: "Base",
        transform: { position: [0, 0.5, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
        op: "box",
        params: { width: 2, height: 1, depth: 2 },
        seed: 7,
        materialId: TOWER_MATERIAL_ID,
      },
      {
        kind: "procedural",
        id: TOWER_MID_ID,
        name: "Middle",
        transform: { position: [0, 1.5, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
        op: "box",
        params: { width: 1.4, height: 1, depth: 1.4 },
        seed: 7,
        materialId: TOWER_MATERIAL_ID,
      },
      {
        kind: "procedural",
        id: TOWER_TOP_ID,
        name: "Top",
        transform: { position: [0, 3, 0], rotationEuler: [0, 0, 0], scale: [1, 1, 1] },
        op: "box",
        params: { width: 0.8, height: 2, depth: 0.8 },
        seed: 7,
        materialId: TOWER_MATERIAL_ID,
      },
    ],
    root: TOWER_ROOT_ID,
  };
}

/** Total tower height in meters: 1 + 1 + 2. Used by bounds assertions. */
export const TOWER_HEIGHT_M = 4;

/** Base footprint in meters. A +20% width edit must produce 2.4 here. */
export const TOWER_BASE_WIDTH_M = 2;
