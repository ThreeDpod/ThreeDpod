import { render, screen } from "@testing-library/react";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  createGeometry,
  SceneViewport,
} from "./scene-viewport.tsx";

describe("SceneViewport and createGeometry", () => {
  describe("createGeometry primitives", () => {
    it("creates BoxGeometry for box spec", () => {
      const geom = createGeometry({
        kind: "box",
        width: 1,
        height: 2,
        depth: 3,
      });
      expect(geom).toBeInstanceOf(THREE.BoxGeometry);
      geom.dispose();
    });

    it("creates CylinderGeometry for cylinder spec", () => {
      const geom = createGeometry({
        kind: "cylinder",
        radiusTop: 0.5,
        radiusBottom: 1.0,
        height: 2.0,
        radialSegments: 16,
      });
      expect(geom).toBeInstanceOf(THREE.CylinderGeometry);
      geom.dispose();
    });

    it("creates SphereGeometry for sphere spec", () => {
      const geom = createGeometry({
        kind: "sphere",
        radius: 1.5,
        widthSegments: 32,
      });
      expect(geom).toBeInstanceOf(THREE.SphereGeometry);
      geom.dispose();
    });

    it("creates ConeGeometry for cone spec", () => {
      const geom = createGeometry({
        kind: "cone",
        radius: 0.8,
        height: 1.6,
        radialSegments: 24,
      });
      expect(geom).toBeInstanceOf(THREE.ConeGeometry);
      geom.dispose();
    });

    it("creates TorusGeometry for torus spec", () => {
      const geom = createGeometry({
        kind: "torus",
        radius: 2.0,
        tube: 0.4,
      });
      expect(geom).toBeInstanceOf(THREE.TorusGeometry);
      geom.dispose();
    });

    it("creates CapsuleGeometry for capsule spec", () => {
      const geom = createGeometry({
        kind: "capsule",
        radius: 0.5,
        length: 2.0,
      });
      expect(geom).toBeInstanceOf(THREE.CapsuleGeometry);
      geom.dispose();
    });
  });

  describe("SceneViewport component mounting", () => {
    it("renders canvas with aria-label or fallback message in jsdom", () => {
      render(<SceneViewport />);

      // In jsdom without WebGL, the fallback message or canvas is mounted
      const canvas = screen.queryByLabelText(/3D Viewport/);
      const fallback = screen.queryByRole("status");

      expect(canvas !== null || fallback !== null).toBe(true);
    });
  });
});
