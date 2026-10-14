"use client";

/**
 * Clarification Card Component.
 *
 * Rendered when the pipeline is in the "needs_input" state. The Scene Planner
 * (DeepSeek-R1) detected essential spatial or structural ambiguity blocking safe
 * 3D construction. This card surfaces the ambiguity reason and one labeled input
 * per question, submitting answers via POST /api/turns/:turnId/clarify.
 */

import { useState } from "react";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
import type { FetchJson } from "../files/use-project-files.ts";
import type { ClarificationState } from "../hooks/use-turn-stream.ts";

export type TurnClarificationCardProps = {
  clarificationState: ClarificationState;
  sessionId?: string;
  baseUrl?: string;
  fetchJson?: FetchJson;
  onSubmitSuccess?: () => void;
  onCancelSuccess?: () => void;
};

const DEFAULT_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export function TurnClarificationCard({
  clarificationState,
  sessionId,
  baseUrl = DEFAULT_BASE_URL,
  fetchJson = credentialedFetch,
  onSubmitSuccess,
  onCancelSuccess,
}: TurnClarificationCardProps) {
  const { turnId, ambiguityReason, questions } = clarificationState;

  const [answers, setAnswers] = useState<string[]>(() =>
    new Array(questions.length).fill(""),
  );
  const [submitting, setSubmitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleAnswerChange = (index: number, value: string) => {
    setAnswers((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setErrorMessage(null);

    try {
      const response = await fetchJson(
        `${baseUrl}/api/turns/${encodeURIComponent(turnId)}/clarify`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answers }),
        },
      );

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(data.error ?? `Request failed with status ${response.status}`);
      }

      onSubmitSuccess?.();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to submit clarification.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async () => {
    if (!sessionId) return;
    setCancelling(true);
    setErrorMessage(null);

    try {
      const response = await fetchJson(
        `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/turns/cancel`,
        {
          method: "POST",
        },
      );

      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(data.error ?? `Cancel failed with status ${response.status}`);
      }

      onCancelSuccess?.();
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : "Failed to cancel turn.",
      );
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div
      role="region"
      aria-label="Clarification needed"
      className="my-4 rounded-xl border border-amber-500/30 bg-amber-950/20 p-5 shadow-lg backdrop-blur-sm"
    >
      <div className="flex items-center gap-2 mb-3">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-amber-500/20 text-amber-400 text-xs font-bold">
          ?
        </span>
        <h3 className="font-semibold text-amber-200 text-base">
          Clarification Needed Before Planning Scene
        </h3>
      </div>

      <div className="mb-4 rounded-lg bg-amber-950/40 p-3 text-sm text-amber-100/90 border border-amber-500/20">
        <p className="font-medium text-amber-300 mb-1">Reason for clarification:</p>
        <p>{ambiguityReason}</p>
      </div>

      {errorMessage && (
        <div
          role="alert"
          className="mb-4 rounded-lg bg-red-950/50 border border-red-500/30 p-3 text-sm text-red-200"
        >
          {errorMessage}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        {questions.map((question, idx) => (
          <div key={`clarification-q-${idx}`} className="space-y-1.5">
            <label
              htmlFor={`clarify-input-${idx}`}
              className="block text-xs font-medium text-neutral-300"
            >
              {question}
            </label>
            <input
              id={`clarify-input-${idx}`}
              type="text"
              value={answers[idx] ?? ""}
              onChange={(e) => handleAnswerChange(idx, e.target.value)}
              placeholder="Your answer..."
              required
              disabled={submitting || cancelling}
              className="w-full rounded-lg border border-neutral-700 bg-neutral-900/80 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-500 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400 disabled:opacity-50"
            />
          </div>
        ))}

        <div className="flex items-center justify-end gap-3 pt-2">
          {sessionId && (
            <button
              type="button"
              onClick={handleCancel}
              disabled={submitting || cancelling}
              className="rounded-lg px-4 py-2 text-xs font-medium text-red-400 hover:bg-red-950/40 hover:text-red-300 transition-colors disabled:opacity-50"
            >
              {cancelling ? "Cancelling..." : "Cancel Turn"}
            </button>
          )}

          <button
            type="submit"
            disabled={submitting || cancelling}
            className="rounded-lg bg-amber-500 px-4 py-2 text-xs font-semibold text-neutral-950 hover:bg-amber-400 transition-colors disabled:opacity-50 shadow-sm"
          >
            {submitting ? "Submitting..." : "Submit Answers"}
          </button>
        </div>
      </form>
    </div>
  );
}
