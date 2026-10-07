import { render, screen, waitFor } from "@testing-library/react";
import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { CHAIR_MODEL_URL, HeroViewport } from "./hero-viewport.tsx";

/**
 * The renderer and the model load are props, not imports, so these prove the
 * lifecycle — loading, ready, unavailable — with fakes rather than with WebGL
 * or a network, neither of which jsdom has.
 */
function fakeRenderer() {
  return { render: vi.fn(), setSize: vi.fn(), dispose: vi.fn() };
}

describe("the hero chair viewport", () => {
  it("points at the sample chair asset", () => {
    expect(CHAIR_MODEL_URL).toBe("/models/sheen-chair.glb");
  });

  it("says the preview is unavailable when WebGL cannot be constructed", () => {
    render(<HeroViewport createRenderer={() => null} loadModel={async () => new THREE.Group()} />);

    expect(screen.getByRole("figure", { name: /sample chair model/i })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/unavailable/i);
  });

  it("credits the sample model's license even when the canvas is missing", () => {
    render(<HeroViewport createRenderer={() => null} loadModel={async () => new THREE.Group()} />);

    expect(screen.getByRole("link", { name: /cc-by 4\.0/i })).toBeInTheDocument();
  });

  it("drops the loading state once the model arrives", async () => {
    const renderer = fakeRenderer();
    render(
      <HeroViewport createRenderer={() => renderer} loadModel={async () => new THREE.Group()} />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(renderer.dispose).not.toHaveBeenCalled();
  });

  it("asks the loader for the configured model", async () => {
    const loadModel = vi.fn(async (_url: string) => new THREE.Group());
    render(<HeroViewport createRenderer={fakeRenderer} loadModel={loadModel} />);

    await waitFor(() => expect(loadModel).toHaveBeenCalledWith(CHAIR_MODEL_URL));
  });

  it("says the preview is unavailable when the model fails to load", async () => {
    render(
      <HeroViewport
        createRenderer={fakeRenderer}
        loadModel={async () => {
          throw new Error("network down");
        }}
      />,
    );

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/unavailable/i));
  });

  it("keeps the floating command out of the accessibility tree", async () => {
    render(
      <HeroViewport createRenderer={fakeRenderer} loadModel={async () => new THREE.Group()} />,
    );

    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    // A hint of the product's voice, not a control: present visually, silent to readers.
    // Asserted through `closest` because a text query walks the DOM, not the
    // accessibility tree, and would find this either way.
    expect(
      screen.getByText(/change the chair material/i).closest("[aria-hidden='true']"),
    ).not.toBeNull();
  });
});
