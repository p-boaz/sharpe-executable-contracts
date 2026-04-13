# Sharpe Executable Contracts MVP

Standalone repo for the Sharpe hackathon track (`Markdown -> executable IR -> deterministic English`).

## Sample Contracts

The repo now includes the full example-contract set referenced in the upstream Sharpe Hackathon repo, plus a couple of extra Law Insider examples for broader testing:

- `contracts/WesTex-VISA-credit-card-agreement.md`
- `contracts/ORBCOMM-Orbital-amendment-1-AIS-payload-procurement-2006.md`
- `contracts/Galleria-Atlanta-office-lease-American-Safety-Insurance-2006.md`
- `contracts/Masterworks084-IndieBrokers-Regulation-A-engagement-letter.md`
- `contracts/A-Plus-Xodtec-securities-exchange-agreement-2009.md`
- `contracts/Sequa-employment-agreement-2005.md`
- `contracts/OneAmerica-MBSC-service-agreement-2015.md`

See `contracts/SOURCES.md` for provenance.

## What this does

1. Ingests contract markdown.
2. Produces an executable IR (`ir.json`).
3. Produces scenario data (`scenarios/<archetype>.json`) with:
   - LLM-required mode (repo now requires `OPENAI_API_KEY`).
   - scenario prompts conditioned on both contract Markdown and extracted IR.
   - fail-fast validation (no deterministic fallback path).
   - stage-level generation metadata in each `scenarios/<archetype>.json`.
4. Executes contract logic (`executions/<archetype>.json`).
5. Deterministically decompiles executable state (`ir + scenario + execution`) back to English (`english.txt`), LLM-free.
6. Verifies deterministic output (`determinism` command).

## Quickstart (9 steps)

1. Install dependencies:
   - `node -v` (recommended: Node `>=20`)
   - `pnpm install`
2. Enable LLM mode (required):
   - `cp .env.example .env` and set `OPENAI_API_KEY`
   - CLI exits early if the key is missing
3. Run pipeline:
   - `pnpm run run --contract contracts/WesTex-VISA-credit-card-agreement.md --out out/run`
4. Inspect outputs:
   - `out/run/ir.json`
   - `out/run/scenarios/<archetype>.json`
   - `out/run/executions/<archetype>.json`
   - `out/run/english.txt`
   - `out/run/meta.json` (`extractIr` + per-archetype `generateScenario` status)
5. Run deterministic check:
   - `pnpm run determinism --contract contracts/WesTex-VISA-credit-card-agreement.md --out out/determinism`
6. Verify determinism artifact:
   - `out/determinism/determinism.json`
   - in LLM-required mode: `irStable` / `scenarioStable` / `executionStable` are `null` by design
   - confirm `englishDecompilerStable` and `englishStable` are `true` (`executable-state -> English` determinism is the guarantee)
7. (Optional) run a second contract family (lease path):
   - `pnpm run run --contract contracts/Galleria-Atlanta-office-lease-American-Safety-Insurance-2006.md --out out/lease-run`
   - inspect `out/lease-run/ir.json`, `scenarios/<archetype>.json`, `executions/<archetype>.json`, `english.txt`
8. (Optional) run focused tests:
   - `pnpm test`
9. (Optional) compare extracted IR against expectation YAMLs:
   - `pnpm run check:expectations`
   - add `--extract` to ignore `out/<contractId>/ir.json` and re-extract live from `contractFile`

## Browser demo (optional)

A Next.js viewer lives in `web/`. It is contract-first: the dropdown reads from `contracts/*.md` (excluding `SOURCES.md`), and the "Process Contract" action runs the same CLI pipeline (`pnpm run run`) into `out/_web_runs/<contract-key>/`. Layout is three zones, top to bottom: **Inputs** (`contract.md` ↔ `english.txt`), **Scenario**, and **Execution**. The IR is available in a collapsible "Show representation" drawer. Hovering a ledger row or English clause line highlights its counterpart.

1. `cd web && pnpm install`
2. `pnpm dev` → open `http://localhost:3000`
3. Pick any bundled contract, click "Process Contract", then inspect scenarios and execution.
4. (Optional) upload a held-out `.md` directly in the UI, then process it the same way.

The page reads artifacts from `../out/` via `fs/promises` in a Server Component — no API routes, no build step for data. Re-run the pipeline and refresh the browser to see new artifacts.

## Notes

- `executable-state -> English` is deterministic and LLM-free (`src/core/decompiler.ts`).
- IR metadata includes deterministic `extractionHash` derived from contract markdown + extractor version.
- IR clauses include `sourceSpan` offsets, and regenerated English includes `[source:start-end]` markers for traceability.
- LLM mode is required. IR/scenario/execution may vary across runs — that's expected, the LLM is nondeterministic. Determinism guarantee is that for a fixed executable state, decompilation to English is stable.
- CLI auto-loads `.env` from repo root before parsing args.
- Extraction/scenario failures are fail-fast (no silent fallback).
- Current executor supports credit-card clauses and a minimal lease monthly-rent path.
- A built-in test suite is available via `pnpm test`.
- This is intentionally small and hackathon-oriented, not legal advice.
- Writeups: `PLAN/END_STATE.md`, `PLAN/DESIGN_DECISIONS.md`, `PLAN/SPEC_AUDIT.md`.
