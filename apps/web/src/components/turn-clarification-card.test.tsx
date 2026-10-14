import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TurnClarificationCard } from "./turn-clarification-card.tsx";

describe("TurnClarificationCard", () => {
  const clarificationState = {
    turnId: "turn-test-1",
    ambiguityReason: "Unclear whether tabletop should be circular or rectangular",
    questions: [
      "What tabletop shape do you prefer?",
      "What should the radius or length be?",
    ],
  };

  it("renders the header, ambiguity reason, and all questions as inputs", () => {
    render(
      <TurnClarificationCard clarificationState={clarificationState} />,
    );

    expect(
      screen.getByText("Clarification Needed Before Planning Scene"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Unclear whether tabletop should be circular or rectangular",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("What tabletop shape do you prefer?"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("What should the radius or length be?"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Submit Answers" }),
    ).toBeInTheDocument();
  });

  it("submits answered clarification to POST /api/turns/:turnId/clarify", async () => {
    const fetchJson = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const onSubmitSuccess = vi.fn();

    render(
      <TurnClarificationCard
        clarificationState={clarificationState}
        fetchJson={fetchJson}
        onSubmitSuccess={onSubmitSuccess}
      />,
    );

    fireEvent.change(
      screen.getByLabelText("What tabletop shape do you prefer?"),
      { target: { value: "Rectangular with bevelled edges" } },
    );
    fireEvent.change(
      screen.getByLabelText("What should the radius or length be?"),
      { target: { value: "1.8 meters" } },
    );

    fireEvent.click(screen.getByRole("button", { name: "Submit Answers" }));

    await waitFor(() => {
      expect(fetchJson).toHaveBeenCalledTimes(1);
    });

    const [url, init] = fetchJson.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/turns/turn-test-1/clarify");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      answers: ["Rectangular with bevelled edges", "1.8 meters"],
    });
    expect(onSubmitSuccess).toHaveBeenCalledTimes(1);
  });

  it("renders cancel button when sessionId is provided and calls cancellation endpoint", async () => {
    const fetchJson = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ cancelled: true }), { status: 200 }),
    );
    const onCancelSuccess = vi.fn();

    render(
      <TurnClarificationCard
        clarificationState={clarificationState}
        sessionId="sess-123"
        fetchJson={fetchJson}
        onCancelSuccess={onCancelSuccess}
      />,
    );

    const cancelButton = screen.getByRole("button", { name: "Cancel Turn" });
    expect(cancelButton).toBeInTheDocument();

    fireEvent.click(cancelButton);

    await waitFor(() => {
      expect(fetchJson).toHaveBeenCalledTimes(1);
    });

    const [url, init] = fetchJson.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/sessions/sess-123/turns/cancel");
    expect(init.method).toBe("POST");
    expect(onCancelSuccess).toHaveBeenCalledTimes(1);
  });

  it("surfaces error message when clarification submission fails", async () => {
    const fetchJson = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: "Turn is no longer in needs_input state" }),
        { status: 409 },
      ),
    );

    render(
      <TurnClarificationCard
        clarificationState={clarificationState}
        fetchJson={fetchJson}
      />,
    );

    fireEvent.change(
      screen.getByLabelText("What tabletop shape do you prefer?"),
      { target: { value: "Circle" } },
    );
    fireEvent.change(
      screen.getByLabelText("What should the radius or length be?"),
      { target: { value: "1.0m" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Submit Answers" }));

    await waitFor(() => {
      expect(
        screen.getByText("Turn is no longer in needs_input state"),
      ).toBeInTheDocument();
    });
  });
});
