import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSceneStore, type SceneNode } from "../../store/scene-store.ts";
import { PropertyInspector } from "./property-inspector.tsx";

describe("PropertyInspector", () => {
  const sampleNodes: Record<string, SceneNode> = {
    desk_group: {
      nodeId: "desk_group",
      name: "Desk Group",
      nodeType: "group",
      parentId: null,
      transform: {
        position: [0, 0, 0],
        rotationDeg: [0, 0, 0],
        scale: [1, 1, 1],
      },
    },
    desk_top: {
      nodeId: "desk_top",
      name: "Table Top",
      nodeType: "mesh",
      parentId: "desk_group",
      transform: {
        position: [0, 0.75, 0],
        rotationDeg: [0, 0, 0],
        scale: [1, 1, 1],
      },
      geometry: { kind: "box", width: 1.6, height: 0.05, depth: 0.8 },
      material: { color: "#8b5a2b", roughness: 0.4, metalness: 0.1 },
    },
  };

  beforeEach(() => {
    defaultSceneStore.reset("test-proj", 1, sampleNodes);
  });

  it("renders scene header, revision badge, and hierarchy tree", () => {
    render(<PropertyInspector />);

    expect(screen.getByText("Scene")).toBeInTheDocument();
    expect(screen.getByText("Rev #1")).toBeInTheDocument();
    expect(screen.getByText("Desk Group")).toBeInTheDocument();
    expect(screen.getByText("Table Top")).toBeInTheDocument();
  });

  it("selects a node on click and displays its transform, geometry, and material", () => {
    render(<PropertyInspector />);

    fireEvent.click(screen.getByText("Table Top"));

    expect(defaultSceneStore.getState().selectedNodeId).toBe("desk_top");
    expect(screen.getByText("ID: desk_top · Type: mesh")).toBeInTheDocument();
    expect(screen.getByText("Transform")).toBeInTheDocument();
    expect(screen.getByText("Geometry (box)")).toBeInTheDocument();
    expect(screen.getByText("PBR Material")).toBeInTheDocument();
  });

  it("updates position when position inputs change", () => {
    render(<PropertyInspector />);

    fireEvent.click(screen.getByText("Table Top"));

    const posXInput = screen.getAllByRole("spinbutton")[0] as HTMLInputElement;
    fireEvent.change(posXInput, { target: { value: "0.5" } });

    expect(defaultSceneStore.getState().nodes.desk_top?.transform.position).toEqual([
      0.5, 0.75, 0,
    ]);
  });

  it("updates geometry width when width input changes", () => {
    render(<PropertyInspector />);

    fireEvent.click(screen.getByText("Table Top"));

    const widthInput = screen.getByDisplayValue("1.6");
    fireEvent.change(widthInput, { target: { value: "2.0" } });

    expect(
      (defaultSceneStore.getState().nodes.desk_top?.geometry as { width: number })
        ?.width,
    ).toBe(2.0);
  });

  it("updates material roughness and color", () => {
    render(<PropertyInspector />);

    fireEvent.click(screen.getByText("Table Top"));

    const roughnessSlider = screen.getByLabelText("Roughness");
    fireEvent.change(roughnessSlider, { target: { value: "0.85" } });

    expect(
      defaultSceneStore.getState().nodes.desk_top?.material?.roughness,
    ).toBeCloseTo(0.85);

    const colorInput = screen.getByLabelText("Color Hex");
    fireEvent.change(colorInput, { target: { value: "#ffffff" } });

    expect(defaultSceneStore.getState().nodes.desk_top?.material?.color).toBe(
      "#ffffff",
    );
  });

  it("deletes a node when delete button is clicked", () => {
    render(<PropertyInspector />);

    const deleteBtn = screen.getByLabelText("Delete Table Top");
    fireEvent.click(deleteBtn);

    expect(defaultSceneStore.getState().nodes.desk_top).toBeUndefined();
  });

  it("supports undo and redo actions", () => {
    render(<PropertyInspector />);

    fireEvent.click(screen.getByText("Table Top"));

    const posXInput = screen.getAllByRole("spinbutton")[0] as HTMLInputElement;
    fireEvent.change(posXInput, { target: { value: "1.2" } });

    expect(defaultSceneStore.getState().nodes.desk_top?.transform.position[0]).toBe(
      1.2,
    );

    const undoBtn = screen.getByLabelText("Undo");
    fireEvent.click(undoBtn);
    expect(defaultSceneStore.getState().nodes.desk_top?.transform.position[0]).toBe(
      0,
    );

    const redoBtn = screen.getByLabelText("Redo");
    fireEvent.click(redoBtn);
    expect(defaultSceneStore.getState().nodes.desk_top?.transform.position[0]).toBe(
      1.2,
    );
  });
});
