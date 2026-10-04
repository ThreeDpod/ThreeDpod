# Threepod

**Create 3D worlds by describing what you imagine.**

Threepod is an AI-native 3D creation workspace for building and refining scenes through natural language. Describe a scene, review the generated result, and request changes conversationally. Threepod combines AI-assisted scene planning with validated scene operations, deterministic procedural geometry, and revision history designed to make edits reproducible and recoverable.

> A model response is a proposal, not proof of success. Threepod validates scene changes and records revisions so the resulting state can be inspected and reconstructed.

## What Threepod does

- **Creates scenes from natural language.** Describe a scene and let the agent propose a structured scene creation operation.
- **Edits scenes conversationally.** Ask for targeted changes, such as widening a base or adjusting an object's dimensions.
- **Validates proposed changes.** Scene proposals are checked against the scene schema and current revision before they are applied.
- **Preserves revision history.** Scene changes are represented as events, allowing the current scene to be reconstructed from the event history.
- **Renders deterministic procedural geometry.** Validated scene specifications are converted into geometry through the procedural modeling pipeline.
- **Handles rejected proposals safely.** A rejected proposal should not modify the current scene.
- **Synchronizes scene revisions to the viewport.** Scene events flow through the event stream to the web interface, where the scene and revision history are reconstructed.

## How it works

```text
Natural-language request
        ↓
Agent interprets intent and reads scene context
        ↓
Typed scene proposal
        ↓
Schema and revision validation
        ↓
Validated scene event
        ↓
Durable event log
        ↓
Scene fold and revision history
        ↓
Procedural geometry
        ↓
Three.js viewport
```

The agent proposes typed operations; trusted application code validates, persists, folds, and renders them. The canonical `SceneSpec` is versioned and renderer-independent. The renderer is not the source of truth.

## Core design principles

- **Structured over arbitrary code:** The model proposes scene operations rather than directly mutating the renderer.
- **Validation before application:** Schema, revision freshness, operation payloads, size limits, and no-op conditions are checked before a proposal is accepted.
- **Durable event history:** Accepted changes and rejections are represented in the event stream.
- **Deterministic reconstruction:** The same valid event history should produce the same scene head and revision chain.
- **Separation of concerns:** Model reasoning, validation, persistence, scene folding, and rendering have distinct responsibilities.
- **Small, verifiable changes:** Features should be added with focused tests and explicit acceptance criteria.

## Current implementation status

The following status reflects the latest project reports provided for this README; it has not been independently re-run while generating this file.

### Reported implemented

- Versioned scene schemas and typed scene creation/edit proposals.
- First-scene creation from an empty event log.
- Validation for malformed, stale, unknown-node, oversized, and no-op proposals.
- Scene-event folding, revision-chain collection, duplicate handling, branch handling, and revert behavior.
- Agent tools for reading the current scene and proposing scene changes.
- PostgreSQL persistence for scene events.
- WebSocket event replay/resume and duplicate-delivery handling.
- Viewport synchronization, shared-scene adoption, conflict notices, and session switching.
- Tests covering PostgreSQL genesis/edit/rejection flows, scene events over replay/resume, duplicate materialization, session switching, and undo/redo edge cases.
- Typecheck and architecture checks reported green.

### Known limitations

- Creation-to-viewport is currently covered in two halves rather than one continuous run: `packages/procedural/src/scene-persistence.test.ts` round-trips persisted file-store data through reconstruction, procedural building, and the viewport-adapter boundary, while `packages/db/src/postgres-event-store.db.test.ts` covers Postgres genesis, validated edits, and rejections through the fold. A continuous Postgres-to-viewport test, WebSocket delivery integration, and real-model edit-quality evaluation remain unverified.
- Real-model scene creation and editing quality have not yet been evaluated.
- Lease-loss and crash windows during scene-event emission remain unverified for scene-specific payloads.
- Very large scene payloads and transport ceilings need explicit testing.
- Refold performance and multi-tab inspector concurrency remain unmeasured.
- Rejection visibility outside the Model tab remains a product decision.
- Inspector edits remain local-only and are not yet routed through the event log.
- Undoing to shared state can prune local overlay operations that redo cannot restore. Branch redo follows the first-inserted child. These behaviors are documented, but the desired product contract remains open.

Test results depend on the current checkout and environment. Re-run the checks before relying on this status.

## Development status and next steps

The next recommended milestone is **integrated reliability verification**.

1. Preserve and review the current working tree, including tracked and untracked changes.
2. Run a fresh baseline of relevant scene, agent, runtime, database, WebSocket, and viewport tests.
3. Add an integrated scripted test for scene creation → edit → PostgreSQL persistence → event replay → viewport reconstruction.
4. Verify that the stored scene, folded scene head, revision chain, and viewport agree.
5. Keep production changes separate from test-only work. If the integrated test reveals a defect, document the evidence and review the smallest fix before implementing it.
6. After the scripted path is stable, evaluate real-model performance with an explicitly approved, limited inference budget.
7. Expand procedural modeling capabilities based on measured evaluation failures rather than speculation.

No software process can guarantee zero failures. Threepod follows a stability-first approach: small changes, reproducible checks, explicit failure reporting, and review before scope expansion.

## Contributing and verification

### Quick start

```bash
bun install
bun run test:fast   # unit, type, and web suites; needs no Docker and no credentials
bun run dev         # web on :3000, API on :3001
```

Use `bun run test`, never `bun test`: `test` is a Bun built-in that shadows the
repository's Vitest script and reports nonsense. These steps alone do not boot the
full app — the API needs a database and credentials. See `docs/DEPLOY.md` for the
complete local boot sequence.

Use the repository's current instructions for setup and development commands. Before submitting a change:

- Inspect the working tree and preserve unrelated changes.
- Run targeted tests first, followed by relevant broader suites.
- Run typecheck, architecture checks, lint, and build where appropriate.
- Run database-backed tests for changes involving persistence.
- Report exact commands, results, environmental blockers, and remaining uncertainties.
- Do not claim end-to-end verification unless the full path has actually been exercised.

## Project direction

Threepod's goal is to make natural-language 3D creation useful and trustworthy: users should be able to create a scene, request precise edits, inspect what changed, and recover a known revision. The immediate priority is to verify the complete scripted lifecycle, measure real-model behavior, and then expand procedural modeling in response to evidence.
