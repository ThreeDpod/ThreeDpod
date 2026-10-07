import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HowItWorks } from "./how-it-works.tsx";

describe("how it works", () => {
  it("labels itself, so the section is findable rather than an unnamed region", () => {
    render(<HowItWorks />);

    expect(
      screen.getByRole("region", { name: /describe\. validate\. edit\./i }),
    ).toBeInTheDocument();
  });

  it("says the loop in three short steps", () => {
    render(<HowItWorks />);
    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);

    expect(titles).toEqual(["Describe", "Validate", "Edit"]);
  });

  it("says rejections change nothing", () => {
    render(<HowItWorks />);

    expect(screen.getByText(/a rejected proposal changes nothing/i)).toBeInTheDocument();
  });

  it("offers nothing to press", () => {
    const { container } = render(<HowItWorks />);
    const section = within(container);

    expect(section.queryAllByRole("link")).toHaveLength(0);
    expect(section.queryAllByRole("button")).toHaveLength(0);
  });
});
