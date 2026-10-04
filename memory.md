# Memory — Threepod Phase 1 + local dev + UI consistency

Last updated: 2026-10-04 (UTC). Branch `main` @ `9ca9cd5`. Work uncommitted.

## What was built

**Threepod Phase 1 slice** (deterministic procedural 3D editor, no AI/GPU/E2B/DB):
- `packages/scene-spec/` (new): versioned Zod SceneSpec (box/cylinder/group, TRS, materials), canonical serialization, vendored sync SHA-256, atomic patches (≤64 ops, stale-base reject), immutable parent-linked revisions + undo/redo, v1 migration registry, shared tower fixture. Tower golden hash `b3534b9a…` (canonical length 997).
- `packages/procedural/` (new): pure-TS engine (exact boxes, trig cylinders, Three.js-matching column-major matrices, baked world verts, 500k-tri budget), `three-adapter.ts`, `export.ts` (real GLTFExporter→GLB→GLTFLoader→bounds compare, 1e-4 m tolerance).
- `apps/web/src/viewport/` (new): 3D Model workbench tab — canvas w/ orbit/lights/grid, scene tree, width inspector, revision history + undo/redo, GLB export + download, in-memory revisions. Selection commits on click (down+up <5px, primary button), not pointerdown.
- Wiring: `tabs.ts` + `workbench.tsx` + `app-shell.tsx` gain third face; `test/architecture.ts` + roster updated. Deps: `three@0.186.1` pinned in procedural + web, `@types/three` devDeps.
- **UI consistency track + `ui-registry.md`** (new, repo root): baseline, P1/P2/P3 applied, exceptions E1/E1b/E2/E3. Applied: 11× `rounded-[5/6/8/9px]`→`rounded-chip`; 5 `--color-syntax-*` tokens in `globals.css` + `file-viewer.tsx` THEME via `var()` (emission verified by compiling the stylesheet); send button gained `enabled:hover:bg-white` to match Resume; selection emissive `0x2a5cff`→`0x7c5cff`.
- **`NAP_OBJECT_STORE=local` escape hatch** (no R2 account needed locally): `packages/storage/src/file-object-store.ts` + tests (traversal-safe, R2-identical error semantics); `env.ts` (`NAP_OBJECT_STORE: r2|local` default r2, `NAP_OBJECT_STORE_DIR` default `.nap-objects`, R2 keys required only on r2); `boot.ts` branch; `.env.example` docs; `.nap-objects/` added to `.gitignore`.
- User confirmed the 3D Model tab renders live at `/p/[projectId]` (SSR contains `workbench-tab-model`; earlier "no visible difference" was navigation — tab lives only in project workspaces, behind sign-in).

## Decisions made

- procedural core has zero three imports; adapter isolated in `three-adapter.ts`.
- Revisions in-memory (persistence deferred); undo = head-pointer move.
- GLB round-trip runs in Node via minimal `FileReader` test shim (exporter genuinely executes).
- `local` store is dev-only, never default; production keeps failing closed without R2. No `!` (explicit unreachable-throw in boot).
- `ui-registry.md` is the UI consistency reference.
- Repo-wide `bun run lint` red is pre-existing (CRLF checkout); only touched-file cleanliness enforced.

## Problems solved

- Zod `discriminatedUnion` needs unique discriminators → two-level union.
- three r186 ships no types → `@types/three`; GLTFExporter needs FileReader → test shim; jsdom lacks `setPointerCapture`/`createObjectURL` → test shims.
- Box/cap winding was inward → fixed, signed-volume test incl. cylinders.
- Review I-1 (blur double-commit) → `setWidth` dirty check; drag-clears-selection → click-gesture pick + 4 gesture tests.
- Web test pool times out under parallel load → `--maxWorkers=1` for web runs.
- `bun run db:migrate` failing despite `.env` set → empty `DATABASE_URL` persisted in Windows env shadows the file (loader: already-exported wins). Fix: remove persisted var or prefix the command.
- Anonymous sign-in 500 `relation "users" does not exist` → dev DB never migrated; `bun run db:migrate` is the documented missing step (README order).
- User pasted live E2B/OpenRouter/secret values into chat → told to rotate all of them.

## Current state

- `typecheck` 16/16 green; Biome clean on all touched files; unit scope 209/209 (+96 storage/api incl. new suites); web viewport+workspace 41/41; arch guard 38/38.
- Full `test:fast`: 4064 pass, 21 pre-existing Windows-env failures — none in new code. `db` suite unrunnable (no Docker daemon; later user started Postgres via compose).
- User's local boot: E2B + OpenRouter keys set, `NAP_OBJECT_STORE=local`, `NAP_ALLOW_DEMO=true`; pending: rotated keys, Postgres up, `db:migrate`, `dev`/`dev:worker`/`dev:reaper`.
- Everything uncommitted (8+ modified files, new dirs, `ui-registry.md`, this `memory.md`; `REPO_MAP.md` pre-existing untracked, not ours).

## Next session starts with

Ask user whether local boot succeeded; if yes, smoke-test a turn. Otherwise: commit the work (all green), or continue to Phase 2 (constrained agent tools, conversational edits, persisted revisions, geometry verification). `git status` first; `test:fast` + `typecheck` after edits.

## Open questions

- Did the user rotate the exposed API keys? (Asked to, unconfirmed.)
- Phase 2+ deferrals unchanged: backend authoritative build, Blender adapter, GPU inference + model benchmark, R3F.
