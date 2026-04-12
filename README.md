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
3. Produces scenario data (`scenario.json`) with:
   - LLM mode (`--use-llm`) when `OPENAI_API_KEY` is present (recommended path for unseen/held-out contracts).
   - deterministic fallback scenario otherwise.
4. Executes contract logic on the scenario (`execution.json`).
5. Deterministically decompiles IR back to English (`english.txt`).
6. Verifies deterministic output (`determinism` command).

## Quickstart (9 steps)

1. Install dependencies:
   - `node -v` (recommended: Node `>=20`)
   - `pnpm install`
2. (Optional) enable LLM mode:
   - `cp .env.example .env`
   - set `OPENAI_API_KEY`
3. Run pipeline (fallback mode):
   - `pnpm run run --contract contracts/WesTex-VISA-credit-card-agreement.md --out out/run`
4. Inspect outputs:
   - `out/run/ir.json`
   - `out/run/scenario.json`
   - `out/run/execution.json`
   - `out/run/english.txt`
5. Run deterministic check:
   - `pnpm run determinism --contract contracts/WesTex-VISA-credit-card-agreement.md --out out/determinism`
6. Verify determinism artifact:
   - `out/determinism/determinism.json`
   - confirm `irStable`, `scenarioStable`, `executionStable`, and `englishStable` are `true`
7. (Optional) run with LLM:
   - append `--use-llm` to `run`/`determinism` commands.
   - use this mode when validating generality on unseen contracts.
8. (Optional) run a second contract family (lease path):
   - `pnpm run run --contract contracts/Galleria-Atlanta-office-lease-American-Safety-Insurance-2006.md --out out/lease-run`
   - inspect `out/lease-run/ir.json`, `scenario.json`, `execution.json`, `english.txt`
9. (Optional) run focused tests:
   - `pnpm test`

## Notes

- `executable -> English` is deterministic and LLM-free (`src/core/decompiler.ts`).
- IR metadata includes deterministic `extractionHash` derived from contract markdown + extractor version.
- IR clauses include `sourceSpan` offsets, and regenerated English includes `[source:start-end]` markers for traceability.
- Current executor supports credit-card clauses and a minimal lease monthly-rent path.
- A built-in test suite is available via `pnpm test`.
- This is intentionally small and hackathon-oriented, not legal advice.
- Writeups: `PLAN/END_STATE.md`, `PLAN/DESIGN_DECISIONS.md`, `PLAN/SPEC_AUDIT.md`.
