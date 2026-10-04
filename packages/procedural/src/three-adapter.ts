/**
 * The only file in the engine that knows Three.js exists.
 *
 * The core (`build.ts`) produces renderer-independent mesh data; this adapter
 * uploads it into BufferGeometries under a Group, one Mesh per scene node. The
 * world transform is already baked into the vertices, so every Mesh sits at the
 * identity — the adapter never re-applies transforms, which is what keeps the
 * rendered scene structurally identical to the built one rather than trusting
 * two transform implementations to agree.
 */

import * as THREE from "three";
import type { BuiltMesh, BuiltScene } from "./build.ts";

function meshToObject(mesh: BuiltMesh): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  const material = new THREE.MeshStandardMaterial({
    color: mesh.material.color,
    metalness: mesh.material.metalness,
    roughness: mesh.material.roughness,
    name: mesh.material.name,
  });
  const object = new THREE.Mesh(geometry, material);
  object.name = mesh.nodeId;
  // The display name is for humans; the stable id is what selection addresses.
  object.userData = { nodeId: mesh.nodeId, displayName: mesh.name };
  return object;
}

/** Upload a built scene into a Group of identity-transformed meshes. */
export function builtSceneToGroup(built: BuiltScene): THREE.Group {
  const group = new THREE.Group();
  group.name = "threepod-scene";
  for (const mesh of built.meshes) {
    group.add(meshToObject(mesh));
  }
  return group;
}

/** Release everything the adapter allocated. Geometries and materials own GPU
 * resources; the group itself is just a container. */
export function disposeGroup(group: THREE.Group): void {
  for (const child of [...group.children]) {
    const mesh = child as THREE.Mesh;
    const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    geometry?.dispose();
    if (Array.isArray(material)) {
      for (const entry of material) entry.dispose();
    } else {
      material?.dispose();
    }
    group.remove(child);
  }
}
